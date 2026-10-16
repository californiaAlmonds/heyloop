# Current State

Updated: 2026-10-15

## Phase
Phase 1 (MVP): daemon **done** · relay **done (local)** · Android app **in progress** (pairing + chat list + read-only conversation)

## Working
- npm-workspaces monorepo: `packages/protocol`, `apps/daemon`, `apps/relay`, `apps/mobile`. Repo at `E:\heyloop`; ongoing work on `develop-californiaAlmonds` (tracks origin).
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
- `apps/mobile`: Expo SDK 57 + Expo Router (`src/app`). Screens: `pair` (QR scan via `expo-camera`, or `heyloop://pair` deep link, always with a confirm step), `index` (chat list, status dots, pending-approval preview, connection banner, unpair), `chat/[id]` (read-only bubbles; approval `command` verbatim).
- Mobile relay client `src/lib/client.ts`: pairing in `expo-secure-store`, WSS + auth frame, backoff, ping, `sync` on daemon `peer online`, contiguous per-chat cursors, acks every msg; 4401 → "unauthorized" + manual retry. History is cached in `expo-sqlite` (`src/lib/cache.ts`, device-verified relaunch restore): rows sealed with a separate `cacheKey` derived from the pairing secret, restored before connecting (newest 300 envelopes/chat + saved cursors), wiped on unpair or when the pairing room changes.
- Mobile actions (device-verified 2026-10-13, incl. answering while the daemon was stopped: delivered once on restart): inline approval buttons (confirm/choice/text; high-risk non-danger options ask an Alert first; hidden after `expires_at`), composer (`say`, allowed while only the computer is offline), header Rename modal. `client.submit()` waits for the daemon `result` (15s); on `unconfirmed` the frame stays queued, is resent with the same id on reconnect, and UI retries reuse that id (`lib/use-action.ts`). Approval answers show the option label and a WhatsApp-style quote of the question; tapping it scrolls to and flashes the original (overlay border, no layout shift).
- Daemon stores each phone frame's result (`frame_results`) and re-replies it when a frame id repeats.
- `src/polyfills.ts` seeds tweetnacl's PRNG from `expo-crypto`; Expo runtime already provides `TextDecoder`/`URL`. `metro.config.js` maps NodeNext `./x.js` imports to `.ts` for the shared protocol package.
- Push doorbells (code done; OAuth + FCM call verified locally, real-device delivery not yet tested): phone registers its native FCM token over the relay (`{t:'push'}`, phone role only, `src/lib/push.ts`, dev build only — Expo Go gets none); daemon tags live envelopes with a `push` hint (`approval` for approval requests, `update` for status with notify); when no fresh phone socket exists the relay sends a generic FCM message (rate limit 15s/kind in DO storage, token dropped on 404). App closes its socket when backgrounded. Relay secret `FCM_SERVICE_ACCOUNT` (Wrangler secret; `.dev.vars` locally, gitignored).
- Cloud: relay deployed to `https://heyloop-relay.heyloop-relay.workers.dev` (Cloudflare account deeja.132024@gmail.com, free plan, SQLite DO). EAS: `apps/mobile/eas.json` (development/preview/production), `GOOGLE_SERVICES_JSON` EAS file variable (sensitive) feeds `app.config.ts`; development build queued under the heyloop-californiaalmonds org.
- Root `package.json` devDependencies pin `react`/`react-dom` to `19.2.3` (Expo SDK 57) so peers hoist one copy (npm `overrides` didn't survive `expo install`). After any `expo install`, check `node_modules/react` is 19.2.3.
- Verified on a real Android phone (Expo Go 57, USB + `adb reverse` for 8787/8081): QR pairing, sync, chat list, conversation, live updates from desktop.
- Relay liveness: sockets silent >75s are closed by a 30s alarm sweep and the peer is told `online:false` (verified with a silent fake daemon: offline at ~90s).
- Frame limits: `MAX_FRAME_CHARS` (512 KiB) shared from `@heyloop/protocol/relay`; relay rejects `send.data` that isn't base64url ciphertext (min nonce+MAC, max frame); daemon sync batches envelopes and chats by size (≤100 envelopes/batch); `open()` returns undefined on malformed input and the daemon ignores non-JSON relay frames. README has a "Self-hosting the relay" guide.
- Unit tests: `npm test -w @heyloop/daemon` (node:test via tsx, `apps/daemon/test/`), also run in CI.
- Real VS Code use (Phase A, 2026-10-16): global `heyloop` bin (`apps/daemon/bin/heyloop.mjs`, tsx loader); `heyloop setup vscode --user` writes the user-level VS Code `mcp.json` (token stays a promptString input) and a managed `prompts/heyloop.instructions.md` telling every agent when to post, ask approval and check inbox; `heyloop autostart install|uninstall|status` (Windows Startup `.cmd` → PowerShell `-EncodedCommand`, hidden, logs to `~/.heyloop/daemon.log`; verified by running it); `heyloop status`. MCP: optional `chat_key` reuses one chat across sessions; `check_inbox` by chat_id/chat_key; approval tools return `inbox` only with final results.
- Phase B prep: existing EAS development APK (2026-10-14, profile development) is still valid — no native config changed since; `eas` and `wrangler` are logged in; relay deploy dry-run OK. Real `~/.heyloop` is not paired yet.
- Dev workflow: Opus lead + Gemini 4 Argon coders via the user-level `gemini-worker` MCP (Vertex), parallel worktrees in `E:\heyloop-wt\`; see `.github/copilot-instructions.md`.
- Verified: workspace typecheck, `expo-doctor` 21/21, `expo export --platform android`, `smoke:relay` 7/7.
- GitHub repo `californiaAlmonds/heyloop` is public; four existing commits pushed unchanged, `origin/main` configured.
- Branch policy: `develop-californiaAlmonds` updates restricted to personal-repo owner (admin bypass); `main` requires PRs, up-to-date Typecheck + Daemon smoke checks, resolved conversations; admins enforced, no force pushes/deletion. No mandatory second-person review.
- `.github/workflows/checks.yml` runs on every main PR and main/develop pushes. Smoke test asserts tool names, inbox delivery, pending/answered approvals, and 409 late answers; isolated local run + typecheck pass.
- README documents setup, CLI, security, limitations, and roadmap. `docs/site/index.html` is the responsive glass-style product website (phone preview labeled concept).
- GitHub Pages enabled with Actions source at `https://californiaalmonds.github.io/heyloop/`; workflow publishes only `docs/site` on relevant `main` pushes.
- Verification: workspace typecheck passes; website anchors, image loading, copy/FAQ controls, and overflow/phone spacing checks pass at 320/390/768/1440px.

## Next
1. Live loop verified 2026-10-16: a Copilot chat in VS Code posted a status and an approval through the deployed relay; the owner answered on the phone (dev APK + Metro LAN). Still to confirm: push doorbell with the app backgrounded/closed.
2. Phone-started chats built 2026-10-16 (daemon window registry + SSE, `apps/vscode` extension installed from `apps/vscode/heyloop.vsix`, phone "New chat" screen with window picker; smoke:relay 12/12). Needs an on-device test: New chat → pick window → prompt starts a Copilot agent chat that reports into the same phone chat. VS Code tool confirmations still block unattended runs.
3. Phone message → next prompt in the linked Copilot chat built 2026-10-16 (session id from `vscode.conversationId`, `prompt` event + delivery ack, inbox fallback; smoke:relay 14/14). Needs on-device test after a VS Code reload.
3. Presence + 30s desktop-first routing gate and stall nudge.
4. Cache limits: no pruning and only the newest 300 envelopes per chat are loaded (no lazy older history yet).
5. Mobile `sync` cursors frame is unbatched (fine below ~10k chats; revisit only if chat counts grow).
6. `smoke:relay` "offline messages are queued and delivered" failed once in 4 runs (timing flake); `daemon.log` has no rotation.

## Open items
- `LICENSE` file — needs copyright holder name (package.json says MIT).
- User to verify HeyLoop domain / Play Store / trademark availability.

## Known limitations
- VS Code's native "Allow" prompts can't be seen or answered by HeyLoop (mitigated by setup notice).
- Multiple phones share one relay queue (one ack removes for all) — fine for single-phone MVP.
- Re-pairing orphans the old relay room (no cleanup alarm yet).
- `presence` frames accepted but not used for routing yet; no stall nudge yet.
