// Thin client for the JustDrop backend (/api/dropzone/*).

import type { EncryptedKeyEntry } from "./crypto.js";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class RoomFullError extends ApiError {
  constructor(message = "This code is already in use by two people.") {
    super(message, 409);
    this.name = "RoomFullError";
  }
}

export class RoomNotFoundError extends ApiError {
  constructor(message = "Room not found (it may have expired).") {
    super(message, 404);
    this.name = "RoomNotFoundError";
  }
}

export interface RoomFileMeta {
  name: string;
  originalName?: string;
  type?: string;
  storageType?: string;
  size: number;
  status: "pending" | "uploading" | "ready" | "downloading";
  downloaded?: boolean;
  isVoiceNote?: boolean;
  path?: string;
  encryptedSymmetricKeys?: EncryptedKeyEntry[];
}

export interface RoomState {
  createdAt?: number;
  expiresAt?: number | null;
  senderPresent?: boolean;
  receiverPresent?: boolean;
  status?: string;
  files?: Record<string, RoomFileMeta>;
  receiverClientId?: string | null;
  receiverLastSeen?: number;
}

type KeyAction = "store-sender-key" | "store-receiver-key" | "get-sender-key" | "get-receiver-key";

export class JustDropApi {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(
    path: string,
    body: unknown,
    method: "POST" | "DELETE" = "POST"
  ): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON error body; fall through to status-based error below.
    }

    if (!res.ok || !json?.success) {
      const message: string = json?.error || `Request to ${path} failed (${res.status})`;
      if (res.status === 409) throw new RoomFullError(message);
      if (res.status === 404) throw new RoomNotFoundError(message);
      throw new ApiError(message, res.status);
    }
    return json;
  }

  async createRoom(timerMinutes: number): Promise<{ roomCode: string; expiresAt: number | null }> {
    const json = await this.request("/api/dropzone/create", { timerMinutes });
    return { roomCode: json.roomCode, expiresAt: json.expiresAt ?? null };
  }

  async join(roomCode: string, clientId: string): Promise<RoomState> {
    const json = await this.request("/api/dropzone/join", { roomCode, clientId });
    return json.data as RoomState;
  }

  async exists(roomCode: string): Promise<boolean> {
    const json = await this.request("/api/dropzone/exists", { roomCode });
    return Boolean(json.exists);
  }

  async storeKey(
    roomCode: string,
    action: Extract<KeyAction, `store-${string}`>,
    publicKey: string,
    clientId?: string
  ): Promise<void> {
    await this.request("/api/dropzone/share-key", { roomCode, action, publicKey, clientId });
  }

  /** Returns the base64 public key, or null when the other party hasn't shared one yet. */
  async getKey(roomCode: string, action: Extract<KeyAction, `get-${string}`>): Promise<string | null> {
    try {
      const json = await this.request("/api/dropzone/share-key", { roomCode, action });
      return json.publicKey ?? null;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  async requestUpload(params: {
    roomCode: string;
    fileName: string;
    fileSize: number;
    originalFileType?: string;
    encryptedSymmetricKeys: EncryptedKeyEntry[];
  }): Promise<{ fileId: string; signedUrl: string; filePath: string }> {
    const json = await this.request("/api/dropzone/upload", {
      roomCode: params.roomCode,
      fileName: params.fileName,
      fileType: "application/octet-stream",
      fileSize: params.fileSize,
      originalFileType: params.originalFileType,
      encryptedSymmetricKeys: params.encryptedSymmetricKeys,
    });
    return { fileId: json.fileId, signedUrl: json.signedUrl, filePath: json.filePath };
  }

  async finalizeUpload(roomCode: string, fileId: string, filePath: string): Promise<void> {
    await this.request("/api/dropzone/finalize-upload", { roomCode, fileId, filePath });
  }

  async download(
    roomCode: string,
    fileId: string
  ): Promise<{ downloadURL: string; fileData: RoomFileMeta }> {
    const json = await this.request("/api/dropzone/download", { roomCode, fileId });
    return { downloadURL: json.downloadURL, fileData: json.fileData as RoomFileMeta };
  }

  async markDownloaded(roomCode: string, fileId: string): Promise<void> {
    await this.request("/api/dropzone/mark-downloaded", { roomCode, fileId });
  }

  async presence(
    roomCode: string,
    userType: "sender" | "receiver",
    isPresent: boolean,
    clientId?: string
  ): Promise<void> {
    await this.request("/api/dropzone/presence", { roomCode, userType, isPresent, clientId });
  }

  async closeRoom(roomCode: string): Promise<void> {
    await this.request("/api/dropzone/close", { roomCode }, "DELETE");
  }
}

/** Uploads an encrypted payload to the GCS signed URL minted by requestUpload. */
export async function putToSignedUrl(signedUrl: string, payload: Uint8Array): Promise<void> {
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: payload,
  });
  if (!res.ok) {
    throw new ApiError(`Storage upload failed (${res.status})`, res.status);
  }
}
