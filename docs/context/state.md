# Current State

Updated: 2026-10-02

## Phase
Phase 1 (MVP): daemon **done** · relay **next** · Android app **pending**

## Working
- npm-workspaces monorepo: `packages/protocol`, `apps/daemon`. Folder renamed `E:\comms.ai` → `E:\heyloop`.
- Daemon on `127.0.0.1:4519/mcp` (bearer token + Host allowlist); config/token/db in `~/.heyloop` (`HEYLOOP_HOME` overrides).
- MCP tools: `send_status_update` (returns inbox), `ask_human_approval` (blocks ≤55s, then `pending`), `await_human_response`.
- Desktop answers via MCP elicitation (VS Code form); request stays pending if dismissed.
- Approval broker: first answer wins (409 for late answers), sweeper expires to `on_timeout` every 5s, chat status tracks `waiting_input`.
- Local REST API used by the CLI (and later the relay): `GET /api/chats`, `PATCH /api/chats/:id`, `GET|POST /api/chats/:id/messages`, `GET /api/approvals`, `POST /api/approvals/:id/answer`.
- CLI: `start`, `token`, `setup vscode [dir]` (writes `.vscode/mcp.json` with prompted token + prints VS Code auto-approve notice), `chats`, `pending`, `answer`, `say`.
- Smoke test passes end to end; typecheck clean.

## Next
1. Initial commit (Conventional Commits).
2. Real-world test in VS Code Copilot agent mode via `heyloop setup vscode`.
3. Relay: Cloudflare Worker + Durable Object per user; daemon connects outbound over WSS; E2E encryption; QR pairing; offline queue; FCM push.
4. Presence detection (away toggle, screen lock, input idle) + 30s desktop-first gate before phone escalation.
5. Android app (Expo dev build): chat list, status dots, rename, notifications with reply actions, approval sheet.

## Open items
- `LICENSE` file — needs copyright holder name (package.json says MIT).
- README not written yet.
- User to verify HeyLoop domain / Play Store / trademark availability.

## Known limitations
- VS Code's native "Allow" prompts can't be seen or answered by HeyLoop (mitigated by setup notice).
- No stall nudge yet (planned: alert when a chat is `running` with no tool calls for ~3 min).
