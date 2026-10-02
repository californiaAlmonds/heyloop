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
- 2026-10-02 — Pairing = one 32-byte secret in the QR; room id, relay auth token and encryption key are derived from it — one scan, relay never gets the key.
- 2026-10-02 — Encryption via tweetnacl secretbox — pure JS, works in Node, Workers and React Native.
- 2026-10-02 — Relay auth is the first WebSocket frame, not headers — browsers/RN can't reliably set WS headers; daemon claims the room on first use.
- 2026-10-02 — Daemon doesn't queue outbound frames; it drops them when offline and the phone re-syncs by cursor — daemon is source of truth.
- 2026-10-02 — Relay queue capped at 2000 per role, oldest dropped — safe because the phone can always re-sync from the daemon.
- 2026-10-02 — Expo hosted project is `@heyloop-californiaalmonds/heyloop`, linked to GitHub `californiaAlmonds`; keep Firebase credentials in ignored local storage — prepare Android builds without committing private keys.
- 2026-10-02 — Firebase project `heyloop-e3808`, Android package `com.californiaalmonds.heyloop`; Spark plan, no Analytics/Gemini — FCM needs neither billing nor analytics.
- 2026-10-02 — Dedicated `heyloop-fcm-sender` service account with Firebase Cloud Messaging API Admin only — push sender does not need broad Firebase Admin permissions; direct FCM relay design unchanged.
- 2026-10-02 — Public website is dependency-free static HTML in `docs/site`, deployed with GitHub Pages Actions; phone illustration explicitly labeled a concept — no build toolchain or false claims of mobile readiness.
