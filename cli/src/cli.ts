#!/usr/bin/env node
// justdrop — send/receive files from the terminal, and set up the JustDrop MCP.
// Thin CLI over the same verified core that powers justdrop-mcp.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { JustDropApi } from "justdrop-mcp/dist/core/api.js";
import { qrString } from "justdrop-mcp/dist/mcp/qr.js";
import {
  assertWithinRoot,
  collectFiles,
  SafetyError,
} from "justdrop-mcp/dist/mcp/safety.js";
import {
  TransferManager,
  type TransferJob,
} from "justdrop-mcp/dist/mcp/transfers.js";

const VERSION = "0.1.0";
const BASE_URL = process.env.JUSTDROP_BASE_URL || "https://justdrop.ai";

const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function help(): void {
  console.log(`
justdrop ${VERSION} — send files to any device. Live, end-to-end encrypted, nothing stored.

Usage:
  justdrop send <files...>          Send files/folders. Prints a QR — scan it on the
                                    other device and the transfer runs automatically.
      -t, --time <minutes>          Room lifetime (default 60, max 1440)
      --room <code>                 Send into an existing room instead

  justdrop get <room-code>          Receive files from a room created at justdrop.ai
      -d, --dir <directory>         Where to save (default: current directory)

  justdrop setup                    Set up the JustDrop MCP for Claude Code
      --desktop                     Also add it to the Claude Desktop app

  justdrop help | version

Files are encrypted before they leave this machine and the room self-destructs
after delivery. No account on either end — the other side just needs a browser.
`);
}

interface Flags {
  positional: string[];
  time?: number;
  room?: string;
  dir?: string;
  desktop?: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-t" || a === "--time" || a === "--expiry") flags.time = Number(argv[++i]);
    else if (a === "--room") flags.room = argv[++i];
    else if (a === "-d" || a === "--dir" || a === "--into") flags.dir = argv[++i];
    else if (a === "--desktop") flags.desktop = true;
    else flags.positional.push(a);
  }
  return flags;
}

async function printBanner(job: TransferJob, withQr: boolean): Promise<void> {
  console.log(`\nRoom code: ${job.roomCode}`);
  console.log(`Link:      ${job.link}`);
  if (job.expiresAt) {
    console.log(`Expires:   ${Math.max(0, Math.round((job.expiresAt - Date.now()) / 60000))} min`);
  }
  if (withQr) {
    console.log(`\nScan to open on a phone:\n`);
    console.log(await qrString(job.link));
  }
}

// ------------------------------------------------------------------ send ----

async function cmdSend(flags: Flags): Promise<number> {
  if (flags.positional.length === 0) {
    console.error("Nothing to send. Usage: justdrop send <files...>");
    return 1;
  }
  const root = process.cwd();
  const api = new JustDropApi(BASE_URL);
  const manager = new TransferManager(api);

  const { files, skipped } = await collectFiles(root, flags.positional);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const expiry = Math.min(Math.max(flags.time ?? 60, 1), 1440);

  const job = await manager.startDrop(files, expiry, flags.room);
  await printBanner(job, !flags.room);

  console.log(`\nSending ${files.length} file(s), ${humanSize(total)} total:`);
  for (const f of files) console.log(`  - ${f.name} (${humanSize(f.size)})`);
  if (skipped.length > 0) console.log(`Skipped (hidden/credential/blocked): ${skipped.join(", ")}`);
  console.log(
    flags.room
      ? "\nUploading now…"
      : "\nWaiting for the other device to open the link… (Ctrl+C to cancel)"
  );

  let cancelled = false;
  process.on("SIGINT", async () => {
    cancelled = true;
    console.log("\nCancelling — destroying the room…");
    await manager.cancel(job.roomCode).catch(() => {});
    process.exit(130);
  });

  // Narrate state transitions until the job settles.
  let peerAnnounced = false;
  const fileStatus = new Map<string, string>();
  for (;;) {
    if (cancelled) return 130;

    if (job.peerPresent && !peerAnnounced) {
      peerAnnounced = true;
      console.log("✓ Other device connected — transferring…");
    }
    for (const f of job.files) {
      const prev = fileStatus.get(f.path);
      if (f.status !== prev) {
        fileStatus.set(f.path, f.status);
        if (f.status === "uploading") console.log(`  ↑ ${f.name} uploading…`);
        if (f.status === "sent") console.log(`  ✓ ${f.name} sent`);
        if (f.status === "downloaded") console.log(`  ✓ ${f.name} downloaded on the other side`);
        if (f.status === "error") console.log(`  ✗ ${f.name} failed: ${f.error}`);
      }
    }

    if (job.state === "completed") {
      // Ephemeral by design: make sure the room is gone before we exit.
      if (!job.joinedExisting) await job.session.closeRoom().catch(() => {});
      console.log("\nDone — delivered, decrypted on the other side, room destroyed. Nothing stored.");
      return 0;
    }
    if (job.state === "expired") {
      console.error("\nThe room expired before the transfer finished.");
      return 1;
    }
    if (job.state === "error") {
      console.error(`\nTransfer failed: ${job.error ?? "unknown error"}`);
      return 1;
    }
    await sleep(400);
  }
}

// ------------------------------------------------------------------- get ----

async function cmdGet(flags: Flags): Promise<number> {
  const root = process.cwd();
  const api = new JustDropApi(BASE_URL);
  const manager = new TransferManager(api);

  const dir = assertWithinRoot(root, flags.dir ?? ".");
  await fs.mkdir(dir, { recursive: true });

  const code = flags.positional[0];
  const job = await manager.startReceive(dir, Math.min(Math.max(flags.time ?? 60, 1), 1440), code);

  if (!code) {
    await printBanner(job, true);
    console.log(
      "\nNote: the justdrop.ai website can only SEND from rooms it created — use this mode\n" +
        "when the other side is another justdrop CLI/MCP. Otherwise: create the room on the\n" +
        "sending device at justdrop.ai and run: justdrop get <room-code>"
    );
  } else {
    console.log(`Joined room ${job.roomCode}.`);
  }
  console.log(`Saving incoming files to: ${dir}`);
  console.log("Waiting for files… (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    const saved = job.received.filter((r) => r.status === "saved").length;
    if (job.joinedExisting) await job.session.leave().catch(() => {});
    else await job.session.closeRoom().catch(() => {});
    console.log(`\nStopped. ${saved} file(s) saved.`);
    process.exit(saved > 0 ? 0 : 130);
  });

  let peerAnnounced = false;
  const seen = new Set<string>();
  for (;;) {
    if (job.peerPresent && !peerAnnounced) {
      peerAnnounced = true;
      console.log("✓ Other device connected.");
    }
    for (const r of job.received) {
      const key = `${r.fileId}:${r.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.status === "downloading") console.log(`  ↓ ${r.name} (${humanSize(r.size)}) downloading…`);
      if (r.status === "saved") console.log(`  ✓ saved: ${r.savedPath}`);
      if (r.status === "error") console.log(`  ✗ ${r.name} failed: ${r.error}`);
    }

    if (job.state === "completed" || job.state === "expired") {
      const saved = job.received.filter((r) => r.status === "saved").length;
      if (saved > 0) {
        console.log(`\nDone — ${saved} file(s) saved, decrypted locally. The room is gone.`);
        return 0;
      }
      console.error("\nThe room closed or expired before any files arrived.");
      return 1;
    }
    if (job.state === "error") {
      console.error(`\nReceive failed: ${job.error ?? "unknown error"}`);
      return 1;
    }
    await sleep(400);
  }
}

// ----------------------------------------------------------------- setup ----

function desktopConfigPath(): string | null {
  const home = os.homedir();
  if (process.platform === "win32" && process.env.APPDATA)
    return path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

async function cmdSetup(flags: Flags): Promise<number> {
  let ok = false;

  // Claude Code (CLI) — register at user scope so it works in every project.
  const probe = spawnSync("claude", ["--version"], { shell: true, encoding: "utf8" });
  if (probe.status === 0) {
    const add = spawnSync(
      "claude",
      ["mcp", "add", "justdrop", "-s", "user", "--", "npx", "-y", "justdrop-mcp"],
      { shell: true, encoding: "utf8" }
    );
    const out = `${add.stdout ?? ""}${add.stderr ?? ""}`;
    if (add.status === 0) {
      console.log("✓ Claude Code: JustDrop MCP registered (user scope).");
      ok = true;
    } else if (/already exists/i.test(out)) {
      console.log("✓ Claude Code: JustDrop MCP was already registered.");
      ok = true;
    } else {
      console.error(`✗ Claude Code registration failed:\n${out.trim()}`);
      if (process.platform === "win32") {
        console.error(`  Try manually: claude mcp add justdrop -s user -- cmd /c npx -y justdrop-mcp`);
      }
    }
  } else {
    console.log("– Claude Code CLI not found on this machine (skipping).");
  }

  // Claude Desktop — only touch its config when explicitly asked.
  if (flags.desktop) {
    const cfgPath = desktopConfigPath();
    if (!cfgPath) {
      console.error("✗ Could not determine the Claude Desktop config location.");
    } else {
      try {
        await fs.access(path.dirname(cfgPath));
        let cfg: any = {};
        try {
          cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
        } catch {
          /* new or empty config */
        }
        cfg.mcpServers = cfg.mcpServers ?? {};
        cfg.mcpServers.justdrop = { command: "npx", args: ["-y", "justdrop-mcp"] };
        await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
        console.log(`✓ Claude Desktop: added to ${cfgPath} — restart the app to load it.`);
        ok = true;
      } catch {
        console.log("– Claude Desktop doesn't appear to be installed (skipping).");
      }
    }
  }

  if (ok) {
    console.log(`\nAll set. Try asking Claude: "send a file to my phone".`);
    return 0;
  }
  console.log(
    `\nManual setup:\n` +
      `  Claude Code:    claude mcp add justdrop -s user -- npx -y justdrop-mcp\n` +
      `  Claude Desktop: add {"command":"npx","args":["-y","justdrop-mcp"]} under mcpServers\n` +
      `                  in claude_desktop_config.json (Settings → Developer → Edit Config)`
  );
  return 1;
}

// ------------------------------------------------------------------ main ----

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  try {
    switch (cmd) {
      case "send":
      case "drop":
        return await cmdSend(flags);
      case "get":
      case "receive":
        return await cmdGet(flags);
      case "setup":
      case "install":
        return await cmdSetup(flags);
      case "version":
      case "--version":
      case "-v":
        console.log(VERSION);
        return 0;
      default:
        help();
        return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
    }
  } catch (err: any) {
    if (err instanceof SafetyError) {
      console.error(`Refused: ${err.message}`);
      return 1;
    }
    console.error(`Error: ${err?.message ?? err}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
