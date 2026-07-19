// Owns active transfers. MCP tool calls return immediately (the user needs the
// room code/QR *before* the peer can join), while workers here wait for the
// peer over SSE, then encrypt/upload or download/decrypt in the background.

import fs from "node:fs/promises";
import path from "node:path";
import { JustDropApi } from "../core/api.js";
import { DropSession } from "../core/session.js";
import { guessMime } from "../core/mime.js";
import { safeSaveName, type CheckedFile } from "./safety.js";

export type DropFileStatus =
  | "queued"
  | "encrypting"
  | "uploading"
  | "sent"
  | "downloaded"
  | "error";

export interface DropFileState {
  path: string;
  name: string;
  size: number;
  status: DropFileStatus;
  fileId?: string;
  error?: string;
}

export interface ReceivedFileState {
  fileId: string;
  name: string;
  size: number;
  status: "downloading" | "saved" | "error";
  savedPath?: string;
  error?: string;
}

export type JobState =
  | "waiting_for_peer"
  | "transferring"
  | "sent_awaiting_download"
  | "completed"
  | "cancelled"
  | "expired"
  | "error";

export interface TransferJob {
  kind: "drop" | "receive";
  roomCode: string;
  link: string;
  createdAt: number;
  expiresAt: number | null;
  state: JobState;
  peerPresent: boolean;
  joinedExisting: boolean;
  files: DropFileState[];
  received: ReceivedFileState[];
  saveDir?: string;
  error?: string;
  session: DropSession;
  abort: AbortController;
  uploadsStarted?: boolean;
}

const TERMINAL_STATES: JobState[] = ["completed", "cancelled", "expired", "error"];
const isTerminal = (s: JobState) => TERMINAL_STATES.includes(s);

export class TransferManager {
  private readonly jobs = new Map<string, TransferJob>();

  constructor(private readonly api: JustDropApi) {}

  link(roomCode: string): string {
    return `${this.api.baseUrl}/app#join=${encodeURIComponent(roomCode)}`;
  }

  get(roomCode: string): TransferJob | undefined {
    return this.jobs.get(roomCode.toLowerCase().trim());
  }

  list(): TransferJob[] {
    return [...this.jobs.values()];
  }

  async startDrop(
    files: CheckedFile[],
    expiryMinutes: number,
    existingRoomCode?: string
  ): Promise<TransferJob> {
    const session = existingRoomCode
      ? await DropSession.joinAsReceiver(this.api, existingRoomCode.toLowerCase().trim())
      : await DropSession.createAsSender(this.api, expiryMinutes);

    const job: TransferJob = {
      kind: "drop",
      roomCode: session.roomCode,
      link: this.link(session.roomCode),
      createdAt: Date.now(),
      expiresAt: session.expiresAt,
      state: existingRoomCode ? "transferring" : "waiting_for_peer",
      peerPresent: Boolean(existingRoomCode),
      joinedExisting: Boolean(existingRoomCode),
      files: files.map((f) => ({ ...f, status: "queued" as const })),
      received: [],
      session,
      abort: new AbortController(),
    };
    this.jobs.set(job.roomCode, job);
    this.runDropWorker(job);
    return job;
  }

  async startReceive(
    saveDir: string,
    expiryMinutes: number,
    existingRoomCode?: string
  ): Promise<TransferJob> {
    const session = existingRoomCode
      ? await DropSession.joinAsReceiver(this.api, existingRoomCode.toLowerCase().trim())
      : await DropSession.createAsSender(this.api, expiryMinutes);

    const job: TransferJob = {
      kind: "receive",
      roomCode: session.roomCode,
      link: this.link(session.roomCode),
      createdAt: Date.now(),
      expiresAt: session.expiresAt,
      state: "waiting_for_peer",
      peerPresent: false,
      joinedExisting: Boolean(existingRoomCode),
      files: [],
      received: [],
      saveDir,
      session,
      abort: new AbortController(),
    };
    this.jobs.set(job.roomCode, job);
    this.runReceiveWorker(job);
    return job;
  }

  async cancel(roomCode: string): Promise<TransferJob> {
    const job = this.get(roomCode);
    if (!job) throw new Error(`No active transfer for room "${roomCode}".`);
    if (!isTerminal(job.state)) job.state = "cancelled";
    job.abort.abort();
    if (job.joinedExisting) {
      // We joined someone else's room — leave politely, never delete it.
      await job.session.leave().catch(() => {});
    } else {
      await job.session.closeRoom().catch(() => {});
    }
    return job;
  }

  // ---------------------------------------------------------------- drop ----

  private runDropWorker(job: TransferJob): void {
    this.armExpiryGuard(job);

    if (job.joinedExisting) {
      // Peer (the room creator) is already there; start uploading right away.
      job.uploadsStarted = true;
      this.runUploads(job).catch((err) => this.failJob(job, err));
    }

    job.session
      .watch((state) => {
        if (state === null) {
          // Room deleted server-side (delivered + closed, expired, or peer closed it).
          if (!isTerminal(job.state)) {
            const allDownloaded =
              job.files.length > 0 && job.files.every((f) => f.status === "downloaded");
            const anyDelivered = job.files.some(
              (f) => f.status === "downloaded" || f.status === "sent"
            );
            job.state = allDownloaded ? "completed" : anyDelivered ? "completed" : "expired";
          }
          job.abort.abort();
          return;
        }

        job.peerPresent = job.joinedExisting
          ? Boolean(state.senderPresent)
          : Boolean(state.receiverPresent);

        for (const f of job.files) {
          if (f.fileId && f.status === "sent" && state.files?.[f.fileId]?.downloaded) {
            f.status = "downloaded";
          }
        }

        if (
          job.files.length > 0 &&
          job.files.every((f) => f.status === "downloaded") &&
          !isTerminal(job.state)
        ) {
          job.state = "completed";
          if (!job.joinedExisting) {
            // Ephemeral by design: self-destruct shortly after delivery.
            const t = setTimeout(() => {
              job.session.closeRoom().catch(() => {});
              job.abort.abort();
            }, 5000);
            t.unref?.();
          } else {
            job.session.leave().catch(() => {});
            job.abort.abort();
          }
        }

        if (job.peerPresent && !job.uploadsStarted) {
          job.uploadsStarted = true;
          this.runUploads(job).catch((err) => this.failJob(job, err));
        }
      }, job.abort.signal)
      .catch(() => {});
  }

  private async runUploads(job: TransferJob): Promise<void> {
    if (!isTerminal(job.state)) job.state = "transferring";

    for (const f of job.files) {
      if (job.abort.signal.aborted) return;
      try {
        f.status = "encrypting";
        const data = new Uint8Array(await fs.readFile(f.path));
        f.fileId = await job.session.sendFile(
          { name: f.name, mime: guessMime(f.name), data },
          (phase) => {
            if (phase === "uploading") f.status = "uploading";
          }
        );
        f.status = "sent";
      } catch (err: any) {
        f.status = "error";
        f.error = String(err?.message ?? err);
      }
    }

    const anyDelivered = job.files.some((f) => f.status === "sent" || f.status === "downloaded");
    if (!anyDelivered) {
      job.state = "error";
      job.error = job.files.find((f) => f.error)?.error ?? "All uploads failed.";
    } else if (job.state === "transferring") {
      job.state = "sent_awaiting_download";
    }
  }

  // ------------------------------------------------------------- receive ----

  private runReceiveWorker(job: TransferJob): void {
    this.armExpiryGuard(job);

    const handled = new Set<string>();
    let chain: Promise<void> = Promise.resolve();

    job.session
      .watch((state) => {
        if (state === null) {
          if (!isTerminal(job.state)) {
            job.state = job.received.some((r) => r.status === "saved") ? "completed" : "expired";
          }
          job.abort.abort();
          return;
        }

        job.peerPresent =
          job.session.role === "sender"
            ? Boolean(state.receiverPresent)
            : Boolean(state.senderPresent);
        if (job.state === "waiting_for_peer" && job.peerPresent) job.state = "transferring";

        for (const [fileId, meta] of Object.entries(state.files ?? {})) {
          if (handled.has(fileId)) continue;
          if (meta.status !== "ready" && meta.status !== "downloading") continue;
          if (meta.downloaded) continue;
          handled.add(fileId);

          const rec: ReceivedFileState = {
            fileId,
            name: meta.originalName || meta.name,
            size: meta.size,
            status: "downloading",
          };
          job.received.push(rec);
          chain = chain.then(() => this.downloadOne(job, rec)).catch(() => {});
        }
      }, job.abort.signal)
      .catch(() => {});
  }

  private async downloadOne(job: TransferJob, rec: ReceivedFileState): Promise<void> {
    try {
      const { name, data } = await job.session.downloadFile(rec.fileId);
      const target = await uniquePath(job.saveDir!, safeSaveName(name));
      await fs.writeFile(target, data);
      rec.savedPath = target;
      rec.status = "saved";
    } catch (err: any) {
      rec.status = "error";
      rec.error = String(err?.message ?? err);
    }
  }

  // ------------------------------------------------------------- helpers ----

  private armExpiryGuard(job: TransferJob): void {
    if (!job.expiresAt) return;
    const remaining = job.expiresAt - Date.now();
    const t = setTimeout(() => {
      if (!isTerminal(job.state)) {
        job.state = "expired";
        job.abort.abort();
      }
    }, Math.max(remaining, 0) + 10_000); // Grace so server-side cleanup wins when it can.
    t.unref?.();
  }

  private failJob(job: TransferJob, err: any): void {
    if (!isTerminal(job.state)) {
      job.state = "error";
      job.error = String(err?.message ?? err);
    }
  }
}

async function uniquePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(dir, i === 0 ? fileName : `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}
