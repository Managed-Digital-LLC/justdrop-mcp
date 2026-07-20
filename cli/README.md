# justdrop

Send files to any device from your terminal — live, end-to-end encrypted, ephemeral. The other side just needs a browser. No accounts, nothing stored.

```bash
npx justdrop send report.pdf
```

A QR code prints in your terminal. Scan it with a phone (or open the link anywhere) — the file transfers immediately, decrypts on the other device, and the room self-destructs. That's it.

```bash
npx justdrop get brave-otter-4821        # receive: room code from justdrop.ai on the other device
npx justdrop get brave-otter-4821 -d ./incoming
```

## Using Claude?

One command wires the JustDrop MCP into Claude Code (and Claude Desktop with `--desktop`):

```bash
npx justdrop setup
npx justdrop setup --desktop
```

Then just tell Claude things like *"send this report to my phone"* or *"grab the photo from my phone"*.

## Commands

| Command | What it does |
|---|---|
| `send <files...>` | Send files/folders. Prints room code + link + QR; transfer runs when the other device opens it. `--time <min>` sets the room lifetime (default 60), `--room <code>` sends into an existing room. |
| `get <room-code>` | Receive files from a room created at [justdrop.ai](https://justdrop.ai). `--dir <path>` chooses where to save (default: current directory). |
| `setup` | Register the JustDrop MCP with Claude Code (`--desktop` also patches Claude Desktop). |

## How it's safe

- Files are encrypted **on your machine** before anything is uploaded; only the two devices in the room hold keys. The relay sees ciphertext only.
- Rooms self-destruct after delivery or when the timer ends — nothing is stored.
- Paths are jailed to the directory you run from; hidden files and credentials are never sent.

Requires Node.js 20+. Built on [`justdrop-mcp`](https://www.npmjs.com/package/justdrop-mcp). MIT licensed.
