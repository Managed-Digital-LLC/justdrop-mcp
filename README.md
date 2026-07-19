# justdrop-mcp

Give your AI agent a way to hand you files — live, end-to-end encrypted, nothing stored.

`justdrop-mcp` is an MCP (Model Context Protocol) server for [JustDrop](https://justdrop.ai). Your agent creates a room, you scan a QR or open a link on any device, and the files move — encrypted before they leave the machine, decrypted only on yours, gone when the room closes. No account on either end. The receiving device needs nothing installed: just a browser.

```
You:    "drop dist/report.pdf to my phone"
Agent:  Room code: brave-otter-4821
        Link: https://justdrop.ai/app#join=brave-otter-4821
        [QR code]
You:    *scan, tap, done — the room self-destructs*
```

It works the other way too: "grab the screenshot from my phone" gives you a QR; whatever you drop from the phone lands decrypted in your working directory, and the agent keeps working with it.

## Install

Requires Node.js 20+.

```bash
claude mcp add justdrop -- npx -y justdrop-mcp
```

Or in `.mcp.json` / any MCP client config:

```json
{
  "mcpServers": {
    "justdrop": {
      "command": "npx",
      "args": ["-y", "justdrop-mcp"],
      "env": {
        "JUSTDROP_ROOT": "C:/path/to/allowed/folder"
      }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `drop` | Send files/folders. Returns room code + link + QR immediately; the transfer runs automatically when the recipient opens the link. Pass `room_code` to send into an existing room instead. |
| `receive` | Receive files into a directory. Creates a room (code + link + QR) and saves anything dropped into it, decrypted, automatically. Pass `room_code` to join a room someone else created. |
| `status` | Live progress: peer presence, per-file state, saved paths. |
| `cancel` | Destroys a room this session created (files + metadata deleted), or leaves a joined room. |

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `JUSTDROP_BASE_URL` | `https://justdrop.ai` | Backend to talk to (point at `http://localhost:3000` for local dev). |
| `JUSTDROP_ROOT` | server's working directory | The **only** directory the server may read from / save into. |
| `JUSTDROP_DEFAULT_EXPIRY_MINUTES` | `60` | Room lifetime when a tool doesn't specify one (1–1440). |

## Safety model

An MCP server that reads local files is a prompt-injection target, so the guardrails are structural, not polite suggestions:

- **Root jail** — every path (sent or saved) must resolve inside `JUSTDROP_ROOT`. Anything else is refused.
- **Credential refusal** — dotfiles (`.env`, `.npmrc`, …), SSH/TLS keys, keystores, cloud credential files, and shell histories are never sent, even when named explicitly. There is no override flag.
- **Explicit manifests** — every `drop` result lists exactly which files were queued, so the user sees what's leaving.
- **Server-side blocklist parity** — extensions JustDrop rejects (`.exe`, `.bat`, …) are refused up front with a hint to zip instead.
- **Ephemeral by default** — rooms carry an expiry (default 60 min) and self-destruct after delivery.

## How the transfer works

1. `drop` creates a room and registers an RSA-2048 public key; the tool returns the code/link/QR immediately.
2. When the recipient opens the link, their browser registers its own key. Rooms are one-to-one by design — treat the room code like the secret it is.
3. Each file gets a fresh AES-256-GCM key, encrypted for both parties' RSA keys. The encrypted blob is relayed through short-lived signed URLs — the relay never sees plaintext or keys.
4. Delivery is observed live; the room (and everything in it) is destroyed afterwards.

Files are encrypted in one shot in memory (format parity with the web app), so very large files need commensurate RAM. The hard cap is 2GB per file.

## Local development

```bash
npm install
npm run verify   # builds, boots ../justdrop-simple dev server, runs both test suites

# or piecewise, against a server you started yourself:
npm run build
node test/e2e.mjs http://localhost:3000        # core roundtrip (both directions + SSE)
node test/mcp-smoke.mjs http://localhost:3000  # full MCP stdio protocol exercise
```

## License

MIT
