// One-shot local verification pipeline:
//   1. compile the package (npx tsc)
//   2. boot the justdrop-simple dev server (unless one is already up)
//   3. run test/e2e.mjs and test/mcp-smoke.mjs against it
//   4. probe the timerMinutes=0 room-code validation bug (report-only)
//   5. tear the dev server down
// Usage: node test/run-local.mjs [baseUrl]
//   - with a baseUrl argument (or JUSTDROP_BASE_URL) it skips booting the dev server.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..");
const webAppDir = path.join(pkgDir, "..", "justdrop-simple");
const tscBin = path.join(pkgDir, "node_modules", "typescript", "bin", "tsc");

const explicitBase = process.argv[2] || process.env.JUSTDROP_BASE_URL;
const baseUrl = explicitBase || "http://localhost:3000";

const log = (...a) => console.log("[run-local]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    );
  });
}

async function serverUp(url) {
  try {
    const res = await fetch(`${url}/api/dropzone/exists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: "probe-room-0000" }),
    });
    return res.status < 500 || res.status === 500; // any HTTP answer means the server is listening
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await serverUp(url)) return;
    await sleep(1500);
  }
  throw new Error(`Dev server did not come up at ${url} within ${timeoutMs / 1000}s`);
}

async function probeTimerZeroBug(url) {
  // Static analysis says create(timerMinutes=0) yields a 4-segment room code
  // (adjective-noun-bip39word-1234) that roomCodeSchema's 3-segment regex then
  // rejects on join/download/close. Verify against the live server; report only.
  log("--- probing timerMinutes=0 room-code bug ---");
  try {
    const createRes = await fetch(`${url}/api/dropzone/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timerMinutes: 0 }),
    });
    const created = await createRes.json().catch(() => null);
    if (!createRes.ok || !created?.success) {
      log(`timer=0 create was refused (${createRes.status}): ${created?.error ?? "no body"}`);
      log("=> untimed rooms cannot even be created; bug is upstream of join.");
      return;
    }
    const code = created.roomCode;
    const segments = String(code).split("-").length;
    log(`timer=0 room created: ${code} (${segments} segments)`);

    const joinRes = await fetch(`${url}/api/dropzone/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: code, clientId: "cafebabecafebabe" }),
    });
    const joined = await joinRes.json().catch(() => null);
    if (joinRes.ok && joined?.success) {
      log("join succeeded — the regex bug does NOT reproduce live.");
    } else {
      log(`CONFIRMED BUG: join of a timer=0 room failed (${joinRes.status}): ${joined?.error}`);
      log("=> 4-segment untimed room codes are rejected by roomCodeSchema; room is unjoinable.");
    }

    await fetch(`${url}/api/dropzone/close`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: code }),
    }).catch(() => {});
  } catch (err) {
    log("timer=0 probe errored:", err?.message ?? err);
  }
  log("--- probe done (informational only) ---");
}

async function main() {
  log("1/4 building (tsc)...");
  // Invoke tsc's JS entry directly: spawning npx.cmd/npm.cmd without a shell
  // throws EINVAL on Node >=18.20 under Windows (CVE-2024-27980 hardening).
  await run(process.execPath, [tscBin], { cwd: pkgDir });
  log("build OK");

  let devServer = null;
  const alreadyUp = await serverUp(baseUrl);
  if (!alreadyUp && !explicitBase) {
    log(`2/4 starting dev server in ${webAppDir} ...`);
    devServer = spawn("npm", ["run", "dev"], {
      cwd: webAppDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    devServer.stdout.on("data", (c) => process.stdout.write(`[dev] ${c}`));
    devServer.stderr.on("data", (c) => process.stderr.write(`[dev] ${c}`));
    await waitForServer(baseUrl);
    log("dev server is up");
  } else {
    log(`2/4 using already-running server at ${baseUrl}`);
  }

  try {
    log("3/4 running core e2e roundtrip...");
    await run(process.execPath, [path.join(here, "e2e.mjs"), baseUrl], { cwd: pkgDir });

    log("3/4 running MCP stdio smoke test...");
    await run(process.execPath, [path.join(here, "mcp-smoke.mjs"), baseUrl], { cwd: pkgDir });

    log("4/4 informational probes...");
    await probeTimerZeroBug(baseUrl);

    log("ALL GREEN — build + e2e + MCP smoke passed.");
  } finally {
    if (devServer) {
      log("stopping dev server...");
      devServer.kill();
      if (process.platform === "win32" && devServer.pid) {
        // Next.js spawns children; make sure the whole tree dies.
        spawn("taskkill", ["/pid", String(devServer.pid), "/T", "/F"], { stdio: "ignore" });
      }
    }
  }
}

main().catch((err) => {
  console.error("[run-local] FAIL:", err?.message ?? err);
  process.exit(1);
});
