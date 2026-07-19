# Phase 2 publish checklist — justdrop-mcp

Everything above the line is DONE; everything below needs Karthik's go and/or an interactive terminal.
(This file is not shipped — the npm tarball only includes `dist/`, README, LICENSE.)

## Done (pre-publish prep, 2026-07-19)

- [x] Name decision: **`justdrop-mcp`** (npm name confirmed available; `justdrop`, `mcp-justdrop`, `@justdrop/*` also free)
- [x] `package.json` metadata: author, homepage, repository, bugs, expanded keywords
- [x] README accuracy pass (removed the unenforced "two-party lock" security claim)
- [x] `npm pack --dry-run` clean: 23 files, ~18 kB — dist/ + README + LICENSE only, no source/tests/secrets
- [x] Local git repo initialized, initial commit `066b96e`
- [x] Verified green: tsc build, local e2e, **prod e2e**, **prod MCP smoke** (all 4 tools + refusals, hash-verified)

## Publish day — EXECUTED 2026-07-19 ✅

- [x] npm account `justdrop` created (username IS the scope owner — no org needed), email verified, passkey 2FA
- [x] GitHub repo live: https://github.com/Managed-Digital-LLC/justdrop-mcp (public, pushed)
- [x] **`justdrop-mcp@0.1.0` PUBLISHED** — 2026-07-19T15:26:51Z, maintainer `justdrop`
- [x] Fresh-install verified: `npx -y justdrop-mcp@0.1.0` boots clean against https://justdrop.ai
- [x] `claude mcp add justdrop -s user -- npx -y justdrop-mcp` → ✓ Connected
- [x] `server.json` drafted for the official MCP registry (namespace `ai.justdrop/mcp`)

### Registry submissions still to do (need interactive login / DNS)

- [ ] **Official MCP registry**: install `mcp-publisher` → `mcp-publisher login dns` (adds a TXT record on justdrop.ai to claim `ai.justdrop/*`) or `mcp-publisher login github` (claims `io.github.managed-digital-llc/*` instead) → validate server.json → `mcp-publisher publish`
- [ ] **Smithery** (smithery.ai): sign in with GitHub, claim the repo
- [ ] **mcp.so**: submit the GitHub URL via their submit flow
- [ ] **PulseMCP / Glama**: auto-index npm+GitHub within days; submit manually to accelerate, and claim the Glama listing
- [ ] **Announce** — per legal posture: benefit-first, never "untraceable"/"subpoena-proof"

## Original runbook (in order)

1. **Create the GitHub repo** `Managed-Digital-LLC/justdrop-mcp` (public) and push:
   ```bash
   gh repo create Managed-Digital-LLC/justdrop-mcp --public --source . --push
   ```
   (package.json `repository` already points at this URL — if a different name is chosen, update package.json first.)

2. **npm login** — interactive browser flow, must run in a real terminal (not an agent shell):
   ```bash
   npm login
   npm whoami   # confirm
   ```

3. **Create the npm org `justdrop`** at https://www.npmjs.com/org/create — this reserves the
   `@justdrop/*` scope for the future `@justdrop/core` split. Free tier is fine (public packages).

4. **Publish:**
   ```bash
   npm publish          # version 0.1.0, public by default (unscoped)
   ```

5. **Post-publish verification:**
   ```bash
   npx -y justdrop-mcp    # should print the "[justdrop-mcp] ready" banner
   claude mcp add justdrop -- npx -y justdrop-mcp
   # then in Claude Code: "drop package.json to my phone" and scan the QR
   ```

6. **Registry submissions** (all need the public GitHub repo from step 1):
   - **Official MCP registry** — install `mcp-publisher`, create `server.json`, and claim the
     domain-verified namespace **`ai.justdrop/mcp`** (DNS TXT record on justdrop.ai proves ownership —
     nobody else can list under the brand). Validate the manifest against the current schema at
     https://github.com/modelcontextprotocol/registry before submitting.
   - **Smithery** (smithery.ai) — sign in with GitHub, claim the repo.
   - **mcp.so** — submit via their form/PR flow.
   - **PulseMCP / Glama** — auto-index npm + GitHub within days; submit manually to accelerate.

7. **Announce** — marketing copy must follow the legal posture: benefit-first plain language,
   never "untraceable" / "subpoena-proof" / "leaves no trace for law enforcement".

## Held for later phases

- `@justdrop/core` split (Phase 0 lib as its own scoped package) — after the org exists
- Bare `justdrop` npm name — claim only with a real user-facing CLI (npm forbids placeholder squatting)
- Remote MCP at justdrop.ai/api/mcp (Phase 3), license-key unlock (Phase 4)
