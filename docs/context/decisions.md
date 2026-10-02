# Decisions Log

Append-only. One line per decision: date — decision — why.

- 2026-10-02 — Build a dedicated app, not a Telegram bot — needs chat list, status, rename, terminal view, calls, local history; bots can't.
- 2026-10-02 — Name: HeyLoop (`heyloop`, `@heyloop/*`) — npm free, no GitHub repos; agentbell/agentping/agentline/hollerback are taken by similar projects.
- 2026-10-02 — Open source, self-hosted relay, no accounts — device pairing is the identity; users deploy their own Worker.
- 2026-10-02 — First integration: VS Code Copilot agent mode via MCP — user's main tool; Claude Enterprise blocks custom connectors.
- 2026-10-02 — Agent adapters later: Claude Agent SDK → Codex SDK → PTY wrapper; Claude Desktop/claude.ai/ChatGPT only as one-way sidecars (they can't accept inbound chats).
- 2026-10-02 — Phone-initiated chats only for agents HeyLoop spawns (SDK/CLI) or via a future VS Code extension (`workbench.action.chat.open`).
- 2026-10-02 — Daemon connects outbound to relay; no tunnels/open ports — smaller attack surface, works behind NAT.
- 2026-10-02 — Daemon SQLite is source of truth; relay holds ciphertext only until delivered; phone caches; per-chat `seq` replay on reconnect.
- 2026-10-02 — Push is a doorbell, not data — app always syncs from last seen `seq`.
- 2026-10-02 — Long waits: tool blocks ≤55s then returns `pending`; agent calls `await_human_response` — avoids MCP client timeouts.
- 2026-10-02 — First answer wins; unanswered → `on_timeout` (default `deny`); late answers get `approval_resolved`/409.
- 2026-10-02 — `chat_id` optional on all tools; omitted creates a chat — VS Code shares one MCP connection across chats.
- 2026-10-02 — User→agent messages delivered via `inbox` on `send_status_update` — no extra polling tool.
- 2026-10-02 — Desktop-first routing: prompt on computer, escalate to phone after 30s; immediate phone if away toggle/locked/idle >2min. Away toggle = handover v1.
- 2026-10-02 — Simple chat-style notifications for MVP; calls (Android alarm/Twilio) deferred.
- 2026-10-02 — Show VS Code auto-approve disclaimer on setup; recommend command allowlist, never global auto-approve.
- 2026-10-02 — HeyLoop tools annotated `readOnlyHint: true` — VS Code otherwise confirms every call.
- 2026-10-02 — Stack: TypeScript, npm workspaces, zod v4, MCP SDK 1.31, built-in `node:sqlite`, Streamable HTTP on localhost — no native deps on Windows.
- 2026-10-02 — Context persists in `docs/context/` (state/decisions/architecture) — VS Code repo memory was lost on folder rename.
