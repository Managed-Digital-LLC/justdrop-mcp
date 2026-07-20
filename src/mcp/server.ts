import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JustDropApi, RoomFullError, RoomNotFoundError } from "../core/api.js";
import { qrString } from "./qr.js";
import {
  assertWithinRoot,
  collectFiles,
  MEMORY_WARN_BYTES,
  SafetyError,
} from "./safety.js";
import { TransferManager, type TransferJob } from "./transfers.js";

export interface ServerConfig {
  baseUrl: string;
  root: string;
  defaultExpiryMinutes: number;
}

const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const minutesLeft = (expiresAt: number | null): string =>
  expiresAt ? `${Math.max(0, Math.round((expiresAt - Date.now()) / 60000))} min` : "no timer";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errorText = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function describeJob(job: TransferJob): string {
  const lines: string[] = [];
  lines.push(`Room: ${job.roomCode}`);
  lines.push(`Mode: ${job.kind === "drop" ? "sending" : "receiving"}`);
  lines.push(`State: ${job.state}`);
  lines.push(`Peer connected: ${job.peerPresent ? "yes" : "no"}`);
  lines.push(`Expires: ${minutesLeft(job.expiresAt)}`);

  if (job.kind === "drop") {
    lines.push(`Files:`);
    for (const f of job.files) {
      const suffix = f.error ? ` — ${f.error}` : "";
      lines.push(`  - ${f.name} (${humanSize(f.size)}): ${f.status}${suffix}`);
    }
  } else {
    lines.push(`Saving to: ${job.saveDir}`);
    if (job.received.length === 0) {
      lines.push(`Received files: none yet`);
    } else {
      lines.push(`Received files:`);
      for (const r of job.received) {
        const where = r.savedPath ? ` -> ${r.savedPath}` : "";
        const suffix = r.error ? ` — ${r.error}` : "";
        lines.push(`  - ${r.name} (${humanSize(r.size)}): ${r.status}${where}${suffix}`);
      }
    }
  }
  if (job.error) lines.push(`Error: ${job.error}`);
  return lines.join("\n");
}

async function roomBanner(job: TransferJob, includeQr: boolean): Promise<string> {
  const parts = [
    `Room code: ${job.roomCode}`,
    `Link: ${job.link}`,
    `Expires: ${minutesLeft(job.expiresAt)}`,
  ];
  if (includeQr) {
    const qr = await qrString(job.link);
    parts.push("Scan to open on a phone:\n```\n" + qr + "\n```");
  }
  return parts.join("\n");
}

export function buildServer(config: ServerConfig): McpServer {
  const api = new JustDropApi(config.baseUrl);
  const manager = new TransferManager(api);

  const server = new McpServer({ name: "justdrop", version: "0.1.2" });

  server.registerTool(
    "drop",
    {
      title: "Drop files to any device",
      description:
        "Send local files through JustDrop: creates a live, end-to-end encrypted, ephemeral room and returns a room code, link, and QR code. " +
        "Use this whenever the user wants to send, share, drop, beam, airdrop, move, or transfer a file or folder to their phone, tablet, laptop, another device, or another person. " +
        "Show the room code, link, and QR block to the user VERBATIM (the QR must stay inside its code fence). " +
        "The transfer starts automatically once the recipient opens the link in any browser; nothing is stored after delivery. " +
        "Pass room_code to send into an existing room instead of creating one. " +
        "Directories are expanded (dotfiles, credentials, and node_modules are always skipped). " +
        "Use the status tool to check delivery progress.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe("Absolute or relative paths of files/directories to send"),
        expiry_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe("Room lifetime in minutes (default 60). The room self-destructs after this."),
        room_code: z
          .string()
          .optional()
          .describe("Join this existing room and send into it, instead of creating a new room"),
      },
    },
    async ({ paths, expiry_minutes, room_code }) => {
      try {
        const { files, skipped } = await collectFiles(config.root, paths);
        const total = files.reduce((sum, f) => sum + f.size, 0);
        const expiry = expiry_minutes ?? config.defaultExpiryMinutes;

        const job = await manager.startDrop(files, expiry, room_code);

        const lines: string[] = [];
        lines.push(await roomBanner(job, !room_code));
        lines.push("");
        lines.push(`Queued ${files.length} file(s), ${humanSize(total)} total:`);
        for (const f of files) lines.push(`  - ${f.name} (${humanSize(f.size)})`);
        if (skipped.length > 0) {
          lines.push(`Skipped (hidden/credential/blocked): ${skipped.join(", ")}`);
        }
        if (total > MEMORY_WARN_BYTES) {
          lines.push(
            `Note: large transfer — files are encrypted in memory, expect high RAM use during send.`
          );
        }
        lines.push("");
        lines.push(
          room_code
            ? "Uploading now — the other party will see the files appear in their room."
            : "Waiting for the recipient to open the link — files transfer automatically when they join, then the room self-destructs."
        );
        return text(lines.join("\n"));
      } catch (err: any) {
        if (err instanceof SafetyError) return errorText(err.message);
        if (err instanceof RoomFullError)
          return errorText("That room already has two participants.");
        if (err instanceof RoomNotFoundError)
          return errorText("That room doesn't exist (or has expired).");
        return errorText(`Drop failed: ${err?.message ?? err}`);
      }
    }
  );

  server.registerTool(
    "receive",
    {
      title: "Receive files from any device",
      description:
        "Receive files into a local directory through JustDrop (live, end-to-end encrypted, ephemeral). " +
        "Use this whenever the user wants to get, grab, pull, fetch, import, or receive a file, photo, screenshot, or document from their phone, tablet, or another device or person onto this machine. " +
        "PREFERRED FLOW: the other person creates a room at justdrop.ai and tells the user the room code; call this tool with that room_code and everything they send is decrypted and saved automatically. " +
        "Without room_code this tool creates the room instead — note the justdrop.ai website can currently only SEND from rooms it created, so use this mode only when the other side is another JustDrop MCP/CLI client. " +
        "Use the status tool to see saved file paths.",
      inputSchema: {
        save_dir: z.string().describe("Directory to save received files into (created if missing)"),
        room_code: z
          .string()
          .optional()
          .describe("Join this existing room instead of creating a new one"),
        expiry_minutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe("Room lifetime in minutes when creating a room (default 60)"),
      },
    },
    async ({ save_dir, room_code, expiry_minutes }) => {
      try {
        const dir = assertWithinRoot(config.root, save_dir);
        await fs.mkdir(dir, { recursive: true });

        const expiry = expiry_minutes ?? config.defaultExpiryMinutes;
        const job = await manager.startReceive(dir, expiry, room_code);

        const lines: string[] = [];
        lines.push(await roomBanner(job, !room_code));
        lines.push("");
        lines.push(`Saving incoming files to: ${dir}`);
        lines.push(
          room_code
            ? "Joined the room — files sent by the other party will be decrypted and saved automatically."
            : "Waiting — when someone opens the link and drops files, they'll be decrypted and saved automatically. Check with the status tool."
        );
        return text(lines.join("\n"));
      } catch (err: any) {
        if (err instanceof SafetyError) return errorText(err.message);
        if (err instanceof RoomFullError)
          return errorText("That room already has two participants.");
        if (err instanceof RoomNotFoundError)
          return errorText("That room doesn't exist (or has expired).");
        return errorText(`Receive failed: ${err?.message ?? err}`);
      }
    }
  );

  server.registerTool(
    "status",
    {
      title: "Check a transfer",
      description:
        "Shows the live status of a JustDrop transfer started with drop or receive: peer presence, per-file progress, saved paths, and errors. " +
        "Call with no room_code to list all transfers in this session.",
      inputSchema: {
        room_code: z.string().optional().describe("Room code returned by drop/receive"),
      },
    },
    async ({ room_code }) => {
      if (room_code) {
        const job = manager.get(room_code);
        if (!job) return errorText(`No transfer for room "${room_code}" in this session.`);
        return text(describeJob(job));
      }
      const jobs = manager.list();
      if (jobs.length === 0) return text("No transfers in this session.");
      return text(jobs.map(describeJob).join("\n\n---\n\n"));
    }
  );

  server.registerTool(
    "cancel",
    {
      title: "Cancel a transfer",
      description:
        "Cancels a JustDrop transfer. Rooms created by this session are destroyed (files and metadata deleted); rooms that were joined are only left.",
      inputSchema: {
        room_code: z.string().describe("Room code returned by drop/receive"),
      },
    },
    async ({ room_code }) => {
      try {
        const job = await manager.cancel(room_code);
        return text(
          job.joinedExisting
            ? `Left room ${job.roomCode}. (The room belongs to the other party and was not deleted.)`
            : `Room ${job.roomCode} destroyed — files and metadata are gone.`
        );
      } catch (err: any) {
        return errorText(String(err?.message ?? err));
      }
    }
  );

  return server;
}

export async function startStdio(config: ServerConfig): Promise<void> {
  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
  console.error(
    `[justdrop-mcp] ready — api: ${config.baseUrl}, root: ${config.root}, default expiry: ${config.defaultExpiryMinutes}m`
  );
}
