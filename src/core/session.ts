// A live JustDrop room session (sender or receiver role) usable from Node.
// Mirrors the browser flow in src/services/dropzoneService.js:
//   create room -> store own RSA public key -> peer joins & stores theirs ->
//   per-file AES key, encrypted bidirectionally -> GCS signed-URL relay.

import { JustDropApi, putToSignedUrl, type RoomFileMeta, type RoomState } from "./api.js";
import {
  createBidirectionalEncryptedKeys,
  decryptBytes,
  decryptUserSymmetricKey,
  encryptBytes,
  exportRsaPublicKey,
  generateAesKey,
  generateRsaKeyPair,
  importRsaPublicKey,
  randomHex,
  type CryptoKey,
  type CryptoKeyPair,
} from "./crypto.js";

const HEARTBEAT_MS = 25_000; // Receiver slot TTL is 60s server-side.

export type SendPhase = "encrypting" | "uploading" | "finalizing";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DropSession {
  private heartbeat: NodeJS.Timeout | undefined;
  private otherPublicKey: CryptoKey | null = null;

  private constructor(
    readonly api: JustDropApi,
    readonly roomCode: string,
    readonly role: "sender" | "receiver",
    private readonly keyPair: CryptoKeyPair,
    readonly expiresAt: number | null,
    private readonly clientId?: string
  ) {}

  static async createAsSender(api: JustDropApi, timerMinutes: number): Promise<DropSession> {
    const { roomCode, expiresAt } = await api.createRoom(timerMinutes);
    const keyPair = await generateRsaKeyPair();
    await api.storeKey(roomCode, "store-sender-key", await exportRsaPublicKey(keyPair.publicKey));
    return new DropSession(api, roomCode, "sender", keyPair, expiresAt);
  }

  static async joinAsReceiver(api: JustDropApi, roomCode: string): Promise<DropSession> {
    const clientId = randomHex(16);
    const state = await api.join(roomCode, clientId);
    const keyPair = await generateRsaKeyPair();
    await api.storeKey(
      roomCode,
      "store-receiver-key",
      await exportRsaPublicKey(keyPair.publicKey),
      clientId
    );
    const session = new DropSession(
      api,
      roomCode,
      "receiver",
      keyPair,
      state?.expiresAt ?? null,
      clientId
    );
    session.startHeartbeat();
    return session;
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      this.api.presence(this.roomCode, "receiver", true, this.clientId).catch(() => {});
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Fetches (and caches) the other party's RSA public key, retrying while they
   * may still be completing their join handshake.
   */
  async fetchPeerPublicKey(attempts = 1, delayMs = 1500): Promise<CryptoKey | null> {
    if (this.otherPublicKey) return this.otherPublicKey;
    const action = this.role === "sender" ? "get-receiver-key" : "get-sender-key";
    for (let i = 0; i < attempts; i++) {
      const keyB64 = await this.api.getKey(this.roomCode, action);
      if (keyB64) {
        this.otherPublicKey = await importRsaPublicKey(keyB64);
        return this.otherPublicKey;
      }
      if (i < attempts - 1) await sleep(delayMs);
    }
    return null;
  }

  watch(onUpdate: (state: RoomState | null) => void, signal: AbortSignal): Promise<void> {
    // Imported lazily at call sites through session to keep one wiring point.
    return import("./sse.js").then(({ watchRoom }) =>
      watchRoom(this.api.baseUrl, this.roomCode, onUpdate, signal)
    );
  }

  /** Encrypts and uploads one file. Requires the peer's public key (they must have joined). */
  async sendFile(
    file: { name: string; mime?: string; data: Uint8Array },
    onPhase?: (phase: SendPhase) => void
  ): Promise<string> {
    const peerKey = await this.fetchPeerPublicKey(10, 1000);
    if (!peerKey) {
      const who = this.role === "sender" ? "Receiver" : "Sender";
      throw new Error(`${who}'s public key not available yet — the other party must join first.`);
    }

    onPhase?.("encrypting");
    const fileKey = await generateAesKey();
    const payload = await encryptBytes(file.data, fileKey);

    const senderPub = this.role === "sender" ? this.keyPair.publicKey : peerKey;
    const receiverPub = this.role === "sender" ? peerKey : this.keyPair.publicKey;
    const encryptedSymmetricKeys = await createBidirectionalEncryptedKeys(
      fileKey,
      senderPub,
      receiverPub
    );

    const { fileId, signedUrl, filePath } = await this.api.requestUpload({
      roomCode: this.roomCode,
      fileName: file.name,
      fileSize: payload.byteLength,
      originalFileType: file.mime || "application/octet-stream",
      encryptedSymmetricKeys,
    });

    onPhase?.("uploading");
    await putToSignedUrl(signedUrl, payload);

    onPhase?.("finalizing");
    await this.api.finalizeUpload(this.roomCode, fileId, filePath);
    return fileId;
  }

  /** Downloads and decrypts one file that is in "ready" state. */
  async downloadFile(
    fileId: string
  ): Promise<{ name: string; mime: string; data: Uint8Array; meta: RoomFileMeta }> {
    const { downloadURL, fileData } = await this.api.download(this.roomCode, fileId);

    const res = await fetch(downloadURL);
    if (!res.ok) throw new Error(`Encrypted download failed (${res.status})`);
    const payload = new Uint8Array(await res.arrayBuffer());

    const entries = fileData.encryptedSymmetricKeys ?? [];
    if (entries.length === 0) {
      throw new Error("File is missing its encrypted key material (unsupported legacy format).");
    }
    const fileKey = await decryptUserSymmetricKey(
      entries,
      this.keyPair.privateKey,
      this.role === "sender"
    );
    const data = await decryptBytes(payload, fileKey);

    await this.api.markDownloaded(this.roomCode, fileId).catch(() => {});
    return {
      name: fileData.originalName || fileData.name,
      mime: fileData.type || "application/octet-stream",
      data,
      meta: fileData,
    };
  }

  /** Stops heartbeats and flags this side as departed. Does not delete the room. */
  async leave(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    await this.api
      .presence(this.roomCode, this.role, false, this.clientId)
      .catch(() => {});
  }

  /** Deletes the room and its files server-side. */
  async closeRoom(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    await this.api.closeRoom(this.roomCode);
  }
}
