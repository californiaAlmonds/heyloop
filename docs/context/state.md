# Current State

Updated: 2026-10-02

## Phase
Phase 1 (MVP): daemon **done** · relay **done (local)** · Android app **next**

## Working
- npm-workspaces monorepo: `packages/protocol`, `apps/daemon`, `apps/relay`. Repo at `E:\heyloop`; 2 commits on `main`.
- Daemon on `127.0.0.1:4519/mcp` (bearer token + Host allowlist); config/token/db in `~/.heyloop` (`HEYLOOP_HOME` overrides).
- MCP tools: `send_status_update` (returns inbox), `ask_human_approval` (blocks ≤55s, then `pending`), `await_human_response`. Desktop answers via MCP elicitation.
- Approval broker: first answer wins (409 late), expiry sweeper → `on_timeout`, chat status tracks `waiting_input`.
- Local REST API for CLI: chats, messages, rename, approvals, answer.
- CLI: `start`, `token`, `setup vscode`, `pair --relay <url>`, `pair` (re-show QR), `unpair`, `chats`, `pending`, `answer`, `say`.
- Pairing: 32-byte secret in QR link `heyloop://pair?v=1&r=<relay>&s=<secret>&n=<name>`; derives room id, relay auth token, secretbox key. Relay URL must be https except loopback.
- Relay (Worker + Durable Object per room): first-frame auth, TOFU room claim by daemon, forwards ciphertext, per-role queue (cap 2000) until ack, peer online/offline frames, ping/pong auto-response.
- Daemon relay client: outbound WSS with backoff, live-forwards envelopes + chat changes, handles phone `sync`/`answer`/`say`/`rename`/`presence`, dedupes phone frames in SQLite.
- Tests: `smoke` (local) and `smoke:relay` (simulated phone) all pass.

## Next
1. Android app (Expo dev build): QR pairing, chat list with status dots, conversation view, approval sheet, reply, rename; local cache with per-chat `seq` cursors.
2. Push: FCM doorbell from relay when phone offline (needs FCM credentials).
3. Presence + 30s desktop-first gate; stall nudge.
4. Deploy relay to Cloudflare (`npm run deploy -w @heyloop/relay`); real-world VS Code test.

## Open items
- `LICENSE` file — needs copyright holder name (package.json says MIT).
- README not written yet.
- User to verify HeyLoop domain / Play Store / trademark availability.

## Known limitations
- VS Code's native "Allow" prompts can't be seen or answered by HeyLoop (mitigated by setup notice).
- Multiple phones share one relay queue (one ack removes for all) — fine for single-phone MVP.
- Re-pairing orphans the old relay room (no cleanup alarm yet).
- `presence` frames accepted but not used for routing yet; no stall nudge yet.
