// Core-library roundtrip against a running JustDrop backend (default: local dev
// server). Exercises the full pipeline both directions:
//   create room -> join -> key exchange -> encrypt+upload -> download+decrypt.
// Usage: node test/e2e.mjs [baseUrl]

import { createHash, randomBytes } from "node:crypto";
import { JustDropApi } from "../dist/core/api.js";
import { DropSession } from "../dist/core/session.js";
import { watchRoom } from "../dist/core/sse.js";

const baseUrl = process.argv[2] || process.env.JUSTDROP_BASE_URL || "http://localhost:3000";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (...args) => console.log("[e2e]", ...args);

function waitForReadyFile(baseUrl, roomCode, excludeIds, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error("Timed out waiting for a ready file"));
    }, timeoutMs);
    watchRoom(baseUrl, roomCode, (state) => {
      if (!state) return;
      for (const [fileId, meta] of Object.entries(state.files ?? {})) {
        if (excludeIds.has(fileId)) continue;
        if (meta.status === "ready") {
          clearTimeout(timer);
          abort.abort();
          resolve(fileId);
          return;
        }
      }
    }, abort.signal).catch(() => {});
  });
}

async function main() {
  log("backend:", baseUrl);
  const api = new JustDropApi(baseUrl);

  // 1. Sender creates the room.
  const sender = await DropSession.createAsSender(api, 30);
  log("room created:", sender.roomCode, "expiresAt:", sender.expiresAt);

  // 2. Receiver joins (like the phone opening the link).
  const receiver = await DropSession.joinAsReceiver(api, sender.roomCode);
  log("receiver joined");

  // 3. Sender -> receiver.
  const payloadA = new Uint8Array(randomBytes(512 * 1024));
  const idA = await sender.sendFile({ name: "roundtrip-a.bin", mime: "application/octet-stream", data: payloadA });
  log("sender uploaded roundtrip-a.bin:", idA);

  const gotA = await receiver.downloadFile(idA);
  if (sha256(gotA.data) !== sha256(payloadA)) throw new Error("sender->receiver hash mismatch");
  if (gotA.name !== "roundtrip-a.bin") throw new Error(`unexpected name: ${gotA.name}`);
  log("receiver decrypted roundtrip-a.bin OK (hashes match)");

  // 4. Receiver -> sender (bidirectional).
  const payloadB = new Uint8Array(randomBytes(256 * 1024));
  const idB = await receiver.sendFile({ name: "roundtrip-b.bin", mime: "application/octet-stream", data: payloadB });
  log("receiver uploaded roundtrip-b.bin:", idB);

  const gotB = await sender.downloadFile(idB);
  if (sha256(gotB.data) !== sha256(payloadB)) throw new Error("receiver->sender hash mismatch");
  log("sender decrypted roundtrip-b.bin OK (hashes match)");

  // 5. SSE watcher sanity: a third upload should surface as "ready" via subscribe.
  const known = new Set([idA, idB]);
  const readyPromise = waitForReadyFile(baseUrl, sender.roomCode, known);
  const payloadC = new Uint8Array(randomBytes(64 * 1024));
  const idC = await sender.sendFile({ name: "roundtrip-c.bin", data: payloadC });
  const seenId = await readyPromise;
  if (seenId !== idC) throw new Error(`SSE surfaced ${seenId}, expected ${idC}`);
  log("SSE watcher surfaced new ready file OK");

  // 6. Close and verify the room is gone.
  await receiver.leave();
  await sender.closeRoom();
  const stillThere = await api.exists(sender.roomCode).catch(() => false);
  if (stillThere) throw new Error("room still exists after close");
  log("room closed and deleted OK");

  log("PASS — full E2E roundtrip succeeded");
}

main().catch((err) => {
  console.error("[e2e] FAIL:", err);
  process.exit(1);
});
