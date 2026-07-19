---
description: Send or receive files with any device — live, E2E encrypted, nothing stored
argument-hint: send <path> | get <room-code> | status | cancel <room-code>
---

The user invoked /justdrop. Use the JustDrop MCP tools (drop, receive, status, cancel) to fulfil this request:

$ARGUMENTS

How to interpret the request:

- **send / drop / share <paths...>** → call the `drop` tool with those paths. Show the returned room code, link, and QR code to the user VERBATIM (keep the QR inside its code fence) so they can scan it with their phone. If they mention a time limit ("for 10 minutes"), pass `expiry_minutes`.
- **get / receive / grab [from] <room-code> [into <dir>]** → call the `receive` tool with that `room_code`. Default `save_dir` to "./incoming" unless they name a directory. Remind them: they create the room at https://justdrop.ai on the sending device and read you the code.
- **get / receive with NO room code** → ask for the room code from the sending device (justdrop.ai → send → code). Only create the room agent-side (receive without room_code) if the other side is another JustDrop MCP/CLI client.
- **status [room-code]** → call the `status` tool (no room code = list all transfers this session).
- **cancel <room-code>** → call the `cancel` tool.
- **empty arguments** → briefly show these subcommands and ask what they'd like to transfer.

Notes:
- Files can only be read from / saved inside the configured root directory. If a path is refused, say why and suggest copying the file into the workspace first.
- Never work around a refused path (dotfiles, credentials) — the refusal is the security model working.
- If a tool reports the room expired or wasn't found, ask the user to generate a fresh code.
