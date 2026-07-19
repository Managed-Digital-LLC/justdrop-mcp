// Drives the built MCP server over real stdio JSON-RPC, playing the "phone"
// side with the core library. Verifies: initialize, tools/list, drop tool
// (room creation + auto-upload on peer join), status tool, receive tool, cancel.
// Usage: node test/mcp-smoke.mjs [baseUrl]

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JustDropApi } from "../dist/core/api.js";
import { DropSession } from "../dist/core/session.js";
import { watchRoom } from "../dist/core/sse.js";

const baseUrl = process.argv[2] || process.env.JUSTDROP_BASE_URL || "http://localhost:3000";
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
const log = (...a) => console.log("[mcp-smoke]", ...a);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
  }
  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    this.child.stdin.write(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 60000);
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

const toolText = (result) => (result.content ?? []).map((c) => c.text ?? "").join("\n");

async function main() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "justdrop-mcp-test-"));
  const outboundPath = path.join(workDir, "hello-from-agent.bin");
  const outboundBytes = new Uint8Array(randomBytes(128 * 1024));
  await fs.writeFile(outboundPath, outboundBytes);
  const saveDir = path.join(workDir, "incoming");

  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, JUSTDROP_BASE_URL: baseUrl, JUSTDROP_ROOT: workDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new McpClient(child);

  try {
    // -- handshake ---------------------------------------------------------
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "0.0.1" },
    });
    log("initialized. server:", init.serverInfo?.name, init.serverInfo?.version);
    client.notify("notifications/initialized", {});

    const tools = await client.request("tools/list", {});
    const names = tools.tools.map((t) => t.name).sort();
    log("tools:", names.join(", "));
    for (const required of ["cancel", "drop", "receive", "status"]) {
      if (!names.includes(required)) throw new Error(`missing tool: ${required}`);
    }

    // -- safety: refuse a path outside the root ----------------------------
    const outside = await client.request("tools/call", {
      name: "drop",
      arguments: { paths: [path.join(os.homedir(), "some-file.txt")] },
    });
    if (!outside.isError) throw new Error("expected out-of-root path to be refused");
    log("out-of-root path refused OK");

    // -- safety: refuse a dotfile ------------------------------------------
    const dotfilePath = path.join(workDir, ".env");
    await fs.writeFile(dotfilePath, "SECRET=1");
    const dotfile = await client.request("tools/call", {
      name: "drop",
      arguments: { paths: [dotfilePath] },
    });
    if (!dotfile.isError) throw new Error("expected dotfile to be refused");
    log("dotfile refused OK");

    // -- drop: agent sends, core-lib plays the phone ------------------------
    const dropResult = await client.request("tools/call", {
      name: "drop",
      arguments: { paths: [outboundPath], expiry_minutes: 30 },
    });
    const dropText = toolText(dropResult);
    if (dropResult.isError) throw new Error(`drop failed: ${dropText}`);
    const roomCode = dropText.match(/Room code: (\S+)/)?.[1];
    if (!roomCode) throw new Error(`no room code in drop output:\n${dropText}`);
    log("drop created room:", roomCode);
    if (!dropText.includes("#join=")) throw new Error("drop output missing join link");

    const api = new JustDropApi(baseUrl);
    const phone = await DropSession.joinAsReceiver(api, roomCode);
    log("phone joined; waiting for auto-upload...");

    const readyFileId = await new Promise((resolve, reject) => {
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
        reject(new Error("timed out waiting for agent upload"));
      }, 45000);
      watchRoom(baseUrl, roomCode, (state) => {
        for (const [fileId, meta] of Object.entries(state?.files ?? {})) {
          if (meta.status === "ready") {
            clearTimeout(timer);
            abort.abort();
            resolve(fileId);
            return;
          }
        }
      }, abort.signal).catch(() => {});
    });

    const received = await phone.downloadFile(readyFileId);
    if (sha256(received.data) !== sha256(outboundBytes)) throw new Error("drop payload hash mismatch");
    log("phone downloaded and decrypted the drop OK");

    await sleep(2500); // Let the server's SSE watcher observe the download.
    const statusResult = await client.request("tools/call", {
      name: "status",
      arguments: { room_code: roomCode },
    });
    const statusText = toolText(statusResult);
    log("status after download:\n" + statusText);
    if (!/downloaded|completed/.test(statusText)) {
      throw new Error("status does not reflect delivery");
    }
    await phone.leave();

    // -- receive: agent receives, core-lib phone sends ----------------------
    const receiveResult = await client.request("tools/call", {
      name: "receive",
      arguments: { save_dir: saveDir, expiry_minutes: 30 },
    });
    const receiveText = toolText(receiveResult);
    if (receiveResult.isError) throw new Error(`receive failed: ${receiveText}`);
    const rxRoom = receiveText.match(/Room code: (\S+)/)?.[1];
    if (!rxRoom) throw new Error(`no room code in receive output:\n${receiveText}`);
    log("receive created room:", rxRoom);

    const phone2 = await DropSession.joinAsReceiver(api, rxRoom);
    const inboundBytes = new Uint8Array(randomBytes(96 * 1024));
    await phone2.sendFile({ name: "photo from phone.png", mime: "image/png", data: inboundBytes });
    log("phone uploaded into receive room; waiting for agent to save...");

    let savedPath = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const st = toolText(
        await client.request("tools/call", { name: "status", arguments: { room_code: rxRoom } })
      );
      const m = st.match(/saved -> (.+)$/m);
      if (m) {
        savedPath = m[1].trim();
        break;
      }
    }
    if (!savedPath) throw new Error("receive never saved the file");
    const savedBytes = new Uint8Array(await fs.readFile(savedPath));
    if (sha256(savedBytes) !== sha256(inboundBytes)) throw new Error("receive payload hash mismatch");
    log("agent saved and decrypted incoming file OK:", savedPath);
    await phone2.leave();

    // -- cancel --------------------------------------------------------------
    const cancelResult = await client.request("tools/call", {
      name: "cancel",
      arguments: { room_code: rxRoom },
    });
    log("cancel:", toolText(cancelResult));
    await sleep(1000);
    const gone = await api.exists(rxRoom).catch(() => false);
    if (gone) throw new Error("receive room still exists after cancel");
    log("cancel destroyed the room OK");

    log("PASS — MCP smoke test succeeded");
  } finally {
    child.kill();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[mcp-smoke] FAIL:", err);
  process.exit(1);
});
