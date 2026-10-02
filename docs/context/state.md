# Current State

Updated: 2026-10-02

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
- Mobile relay client `src/lib/client.ts`: pairing in `expo-secure-store`, WSS + auth frame, backoff, ping, `sync` on daemon `peer online`, contiguous per-chat cursors, acks every msg; 4401 → "unauthorized" + manual retry. State is in-memory only (full re-sync per launch).
- `src/polyfills.ts` seeds tweetnacl's PRNG from `expo-crypto`; Expo runtime already provides `TextDecoder`/`URL`. `metro.config.js` maps NodeNext `./x.js` imports to `.ts` for the shared protocol package.
- Root `package.json` `overrides` pin `react`/`react-dom` to `19.2.3` (Expo SDK 57) so `react@*` peers don't install a second copy.
- Verified: workspace typecheck, `expo-doctor` 21/21, `expo export --platform android` bundles. Not yet run on a device.
- GitHub repo `californiaAlmonds/heyloop` is public; four existing commits pushed unchanged, `origin/main` configured.
- Branch policy: `develop-californiaAlmonds` updates restricted to personal-repo owner (admin bypass); `main` requires PRs, up-to-date Typecheck + Daemon smoke checks, resolved conversations; admins enforced, no force pushes/deletion. No mandatory second-person review.
- `.github/workflows/checks.yml` runs on every main PR and main/develop pushes. Smoke test asserts tool names, inbox delivery, pending/answered approvals, and 409 late answers; isolated local run + typecheck pass.
- README documents setup, CLI, security, limitations, and roadmap. `docs/site/index.html` is the responsive glass-style product website (phone preview labeled concept).
- GitHub Pages enabled with Actions source at `https://californiaalmonds.github.io/heyloop/`; workflow publishes only `docs/site` on relevant `main` pushes.
- Verification: workspace typecheck passes; website anchors, image loading, copy/FAQ controls, and overflow/phone spacing checks pass at 320/390/768/1440px.

## Next
1. Run the app on a device (Expo Go works for now: camera/secure-store/crypto are bundled) against the local relay via `adb reverse tcp:8787 tcp:8787`; fix runtime issues.
2. Mobile actions: approval sheet (answer), reply (`say`), rename; show `result` errors.
3. Persist cache + cursors (expo-sqlite) so launches don't re-sync everything.
4. Push: FCM doorbell from relay when phone offline (needs FCM credentials); then presence + 30s desktop-first gate; stall nudge.
5. `eas.json` + development build; deploy relay to Cloudflare; real-world VS Code test.

## Open items
- `LICENSE` file — needs copyright holder name (package.json says MIT).
- User to verify HeyLoop domain / Play Store / trademark availability.

## Known limitations
- VS Code's native "Allow" prompts can't be seen or answered by HeyLoop (mitigated by setup notice).
- Multiple phones share one relay queue (one ack removes for all) — fine for single-phone MVP.
- Re-pairing orphans the old relay room (no cleanup alarm yet).
- `presence` frames accepted but not used for routing yet; no stall nudge yet.
