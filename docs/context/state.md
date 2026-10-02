# Current State

Updated: 2026-10-02

## Phase
Phase 1 (MVP): daemon **done** · relay **done (local)** · Android app **next**

## Working
- npm-workspaces monorepo: `packages/protocol`, `apps/daemon`, `apps/relay`, `apps/mobile`. Repo at `E:\heyloop`, branch `main`.
- Daemon on `127.0.0.1:4519/mcp` (bearer token + Host allowlist); config/token/db in `~/.heyloop` (`HEYLOOP_HOME` overrides).
- MCP tools: `send_status_update` (returns inbox), `ask_human_approval` (blocks ≤55s, then `pending`), `await_human_response`. Desktop answers via MCP elicitation.
- Approval broker: first answer wins (409 late), expiry sweeper → `on_timeout`, chat status tracks `waiting_input`.
- Local REST API for CLI: chats, messages, rename, approvals, answer.
- CLI: `start`, `token`, `setup vscode`, `pair --relay <url>`, `pair` (re-show QR), `unpair`, `chats`, `pending`, `answer`, `say`.
- Pairing: 32-byte secret in QR link `heyloop://pair?v=1&r=<relay>&s=<secret>&n=<name>`; derives room id, relay auth token, secretbox key. Relay URL must be https except loopback.
- Relay (Worker + Durable Object per room): first-frame auth, TOFU room claim by daemon, forwards ciphertext, per-role queue (cap 2000) until ack, peer online/offline frames, ping/pong auto-response.
- Daemon relay client: outbound WSS with backoff, live-forwards envelopes + chat changes, handles phone `sync`/`answer`/`say`/`rename`/`presence`, dedupes phone frames in SQLite.
- Tests: `smoke` (local) and `smoke:relay` (simulated phone) all pass.
- Expo organization `heyloop-californiaalmonds`, project `heyloop` (EAS ID `145fea2a-0d75-41a7-b415-67fceef9ebad`), linked from `apps/mobile/app.json`.
- Firebase `heyloop-e3808` (Spark plan, FCM HTTP v1). Android package `com.californiaalmonds.heyloop`.
- Firebase Android config + messaging-only service-account key in ignored `.credentials/firebase/`. Expo key upload pending manual file selection. Personal setup notes in ignored `docs/context/cloud-setup.md`.
- `apps/mobile`: Expo SDK 57 blank TypeScript scaffold; `app.config.ts` reads `GOOGLE_SERVICES_JSON` (EAS file env) or the local `.credentials` path.
- GitHub repo `californiaAlmonds/heyloop` is public; four existing commits pushed unchanged, `origin/main` configured.
- README documents setup, CLI, security, limitations, and roadmap. `docs/site/index.html` is the responsive glass-style product website (phone preview labeled concept).
- GitHub Pages enabled with Actions source at `https://californiaalmonds.github.io/heyloop/`; workflow publishes only `docs/site` on relevant `main` pushes.
- Verification: workspace typecheck passes; website anchors, image loading, copy/FAQ controls, and overflow/phone spacing checks pass at 320/390/768/1440px.

## Next
1. Android app (Expo dev build): QR pairing, chat list with status dots, conversation view, approval sheet, reply, rename; local cache with per-chat `seq` cursors.
2. Push: FCM doorbell from relay when phone offline (needs FCM credentials).
3. Presence + 30s desktop-first gate; stall nudge.
4. Deploy relay to Cloudflare (`npm run deploy -w @heyloop/relay`); real-world VS Code test.

## Open items
- `LICENSE` file — needs copyright holder name (package.json says MIT).
- User to verify HeyLoop domain / Play Store / trademark availability.

## Known limitations
- VS Code's native "Allow" prompts can't be seen or answered by HeyLoop (mitigated by setup notice).
- Multiple phones share one relay queue (one ack removes for all) — fine for single-phone MVP.
- Re-pairing orphans the old relay room (no cleanup alarm yet).
- `presence` frames accepted but not used for routing yet; no stall nudge yet.
