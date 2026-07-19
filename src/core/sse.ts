// SSE consumer for /api/dropzone/subscribe (Node has no EventSource; we read
// the stream from fetch directly). Reconnects with backoff until the room
// disappears or the caller aborts.

import type { RoomState } from "./api.js";

const RECONNECT_DELAY_MS = 2000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Watches a room until it is deleted server-side (update of `null`), the
 * signal aborts, or an unrecoverable error occurs. Resolves when watching ends.
 */
export async function watchRoom(
  baseUrl: string,
  roomCode: string,
  onUpdate: (state: RoomState | null) => void,
  signal: AbortSignal
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/dropzone/subscribe?roomCode=${encodeURIComponent(
    roomCode
  )}`;

  while (!signal.aborted) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) {
        await sleep(RECONNECT_DELAY_MS, signal);
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const dataLine = rawEvent
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          const state = (parsed?.data ?? null) as RoomState | null;
          onUpdate(state);
          if (state === null) return; // Room deleted — subscription is over.
        }
      }
    } catch (err: any) {
      if (signal.aborted || err?.name === "AbortError") return;
      // Transient network error — reconnect below.
    }
    if (!signal.aborted) await sleep(RECONNECT_DELAY_MS, signal);
  }
}
