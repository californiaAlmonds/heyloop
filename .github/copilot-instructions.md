## Project map (read this before searching; keep it current when structure changes)
- **Purpose:** self-hosted bridge from long-running AI coding agents (via MCP) to a phone app for status, approvals, and replies; E2E encrypted.
- **Stack:** npm workspaces, TypeScript strict ESM (NodeNext), Node 22.13+ (`node:sqlite`), zod v4, `@modelcontextprotocol/sdk` 1.31, tweetnacl; relay = Cloudflare Worker + Durable Object (wrangler 4); mobile = Expo SDK 57, Expo Router, React 19.2.3, RN 0.86.
- **Commands:** `npm install` · `npm run typecheck` (no lint) · daemon `npm run cli -w @heyloop/daemon -- start` (127.0.0.1:4519/mcp) · `npm run smoke -w @heyloop/daemon` · relay `npm run dev -w @heyloop/relay` (port 8787) + `npm run smoke:relay -w @heyloop/daemon` · mobile `npx expo start` / `npx expo export --platform android` from `apps/mobile`. No build step; TS runs via `tsx`.
- `packages/protocol/src/` — zod contracts: `index.ts` (envelopes, MCP tools), `relay.ts` (relay/app frames), `crypto.ts` (pairing, secretbox). Change here first.
- `apps/daemon/src/` — `mcp.ts` tools, `broker.ts` approvals, `store.ts` SQLite, `server.ts` HTTP/REST, `relay-client.ts`, `cli.ts`, `config.ts`, `vscode.ts` (VS Code setup), `autostart.ts`, `agent-instructions.ts`; `bin/heyloop.mjs` global command; `scripts/` smoke tests; `test/` unit tests (`npm test -w @heyloop/daemon`).
- `apps/relay/src/index.ts` — Worker + per-room Durable Object; forwards/queues ciphertext only.
- `apps/vscode/` — VS Code extension `heyloop-vscode` (esbuild bundle, `npm run package -w heyloop-vscode` → `heyloop.vsix`, install with `code --install-extension`): receives phone-started chats over the daemon SSE stream.
- `apps/mobile/src/` — `app/` routes (`pair`, `index` chat list, `chat/[id]`), `lib/client.ts` relay client, `polyfills.ts` PRNG seed.
- `docs/context/` — `state.md` (read first), `architecture.md`, `decisions.md`; `docs/site/` static website (GitHub Pages).
- `.github/agents/` — Scout (Haiku), Verifier (Sonnet), Reviewer (GPT) subagents. Worktrees for coder tasks live in `E:\heyloop-wt\<slug>` (outside the repo).
- **Flow:** agent → MCP (bearer token) → daemon (SQLite + broker) → outbound WSS, secretbox-encrypted → relay room → phone; phone `answer`/`say`/`sync` back the same path; first answer wins.
- **Conventions:** relative imports use `.js`; don't re-export `relay`/`crypto` from protocol `index.ts` (circular); mobile Metro maps `.js`→`.ts`; Conventional Commits; update `docs/context/` after each task (see AGENTS.md).
- **Env:** no `.env.example`. `HEYLOOP_HOME` (daemon data dir, default `~/.heyloop`), `GOOGLE_SERVICES_JSON` (mobile, default `.credentials/firebase/google-services.json`).

## Team and workflow
If you are running as the Scout, Verifier, or Reviewer subagent, ignore this section.

### Roles
- **Owner (the user): the managerial side.** Sets goals and approves direction. Don't ask the owner technical questions you can answer yourself.
- **Lead (you, Claude Opus): owns everything technical.** You own architecture, plans, task splits, briefs, review, merges, commits, deploys after approval, and `docs/context/`. Implement yourself only when a change is trivial (about 20 lines or fewer), or when briefing it would take longer than doing it.
- **Coder: Gemini 4 Argon, via the `gemini-worker` MCP tool `gemini_delegate`.** This is the default for all implementation work. Run as many instances in parallel as you can review well.
- **Research:**
  - `gemini_ask` is read-only Argon. It can read the repo and search the web with sources. Use it for library and API questions, version checks, and second opinions.
  - **Scout** (Haiku) handles quick repo lookups such as "where is X, which files touch Y". Use it before writing briefs.
- **Review:**
  - **Verifier** (Sonnet) is the default reviewer of non-trivial Argon diffs.
  - **Reviewer** (GPT) also reviews anything security-sensitive: crypto and pairing, auth and tokens, the relay, daemon network surface, approvals, and secrets.
- Optimize for quality and throughput, not token cost. Parallelize independent work and use reviewers freely.

### Owner approval gates (ask, then wait)
- A new feature, phase, or direction: present a short plan of goal, tasks, risks and how you'll verify. Work inside an already-approved plan proceeds without asking again.
- Changing or reversing an entry in `docs/context/decisions.md`.
- Pushing, merging to `main`, deploys (relay, EAS builds, Pages), publishing, anything public, paid, or hard to reverse.
- Never ask about implementation details, library choices within the stack, refactors inside scope, or test strategy. Decide those yourself and report them.

### Delivery loop
1. **Orient.** Read `docs/context/state.md`, then use Scout or `gemini_ask` for the facts you need.
2. **Plan.** Split the work into independent tasks, where no two tasks edit the same file. Get owner approval if a gate above applies.
3. **Isolate.** Give each coder task its own worktree and branch:
   - Run `git worktree add E:\heyloop-wt\<slug> -b gw/<slug>`.
   - Then run `npm install --prefer-offline --no-audit --no-fund` inside it, which takes about 35s. This is required if the task runs typecheck or tests, so that `@heyloop/protocol` resolves to the worktree's copy.
   - Docs-only tasks skip the install and use `allow_commands: false`.
   - Worktrees don't contain untracked or ignored files such as `.dev.vars` or `.credentials/`.
4. **Brief.** Each `gemini_delegate` call must be self-contained, because Argon sees only the brief and the folder.
   - `task`: the goal, the exact files or areas involved, and the constraints.
   - `context`: relevant conventions (protocol first, `.js` imports, security rules), facts you already verified, and "do NOT edit `docs/context/*`".
   - `acceptance_criteria`: the exact commands that must pass, plus the behavior a one-off check must prove.
   - Tell it to report gaps in `open_questions` rather than invent commands, APIs or facts.
   - Use plain wording. Gemini's safety filter refuses prompts that sound like attacks or escapes.
   - Set `timeout_minutes` to 15–45.
5. **Run in parallel.** Issue independent `gemini_delegate` calls in the same tool batch. Small tasks take about 4–10 minutes.
6. **Review. This is mandatory, and you don't trust the self-report.**
   - Read `git diff` yourself.
   - Re-run typecheck yourself, plus smoke tests when daemon or relay behavior changed.
   - Compare `files_changed` (taken from git) with what was claimed, and read `blocked` and `open_questions`.
   - Spot-check any facts it cites.
   - Send non-trivial diffs to the Verifier, and security-sensitive ones to the Reviewer as well.
   - If something is wrong, send a follow-up delegate with the concrete findings and your decision, or fix trivial issues yourself.
7. **Integrate.**
   - Commit in the worktree using Conventional Commits.
   - From `E:\heyloop`, run `git merge --no-ff gw/<slug>`.
   - Re-run typecheck on the merged branch.
   - Run `git worktree remove` and `git branch -d`, and delete any leftover `E:\heyloop-wt\<slug>` folder.
   - Never push without owner approval.
8. **Close.** Update `docs/context/` (see AGENTS.md), then report to the owner.

### gemini-worker facts
- **Server:** `C:\Users\Deepak\.mcp-servers\gemini-worker\server.py`. It is registered in the user-level `mcp.json` and runs Vertex `gemini-4-argon` through the Antigravity SDK.
- **`gemini_delegate` inputs:** `task`, `workdir` (absolute path of the project folder), `context`, `acceptance_criteria`, `allow_commands` (default true), and `timeout_minutes` (default 30, max 120).
- **`gemini_delegate` returns:**
  - status: `done`, `partial`, `blocked`, `timeout` or `error`
  - summary, verification, and open_questions
  - `files_changed` (from git), plus `git_diff_stat`
  - `commands_run` (executed commands only), plus `blocked` (denied tool calls)
- **Worker limits:**
  - It can't commit, push, deploy or publish, or use `gcloud`, `wrangler`, `eas` or `gh`, run destructive deletes, or change system or environment settings.
  - File tools are confined to the workdir. Shell commands are confined on a best-effort basis only, so your review is the real control.
  - Because of this, you do all git work, deploys, and dev servers (wrangler dev, daemon start).
- **Large results:** results can be saved to a file instead of returned inline; read them with `read_file`.
- **If the server or Vertex sign-in fails:** do the work yourself and tell the owner.

## Working rules
- Plan small, act, verify by running the build, lint, or tests. Check UI changes in the browser.
- Don't re-read files that are already in context. Read targeted line ranges.
- Follow existing conventions. Make minimal changes.
- Write secure code: validate every inbound MCP, REST, and relay frame with the protocol zod schemas, use parameterized SQLite statements, keep the daemon on 127.0.0.1 with bearer token + Host allowlist, let the relay see ciphertext only, never log tokens or pairing secrets, and use no `eval`.
- Final report to the owner: 2-5 lines covering what changed, how it was verified, decisions you made, and anything that needs their approval. Add one line: `Team: Argon ×<n>, Scout ×<n>, Verifier ×<n>, Reviewer ×<n>` (omit zeros).

## Context discipline (keep chats long-lived)
- Search before reading: use grep or file search, then read only the matching line ranges. Never read `package-lock.json`, `node_modules/`, `dist/`, `.wrangler/`, `.expo/`, `.credentials/`, or `.playwright-mcp/`.
- Keep terminal output small. Chain commands into one call and trim output, for example `npm run typecheck 2>&1 | Select-Object -Last 40` or `npm run smoke -w @heyloop/daemon 2>&1 | Select-Object -Last 20`. Never dump full logs, JSON payloads, or HTML.
- For browser checks (the `docs/site` website, the GitHub repo and Actions, the Expo or EAS dashboards, the Cloudflare dashboard):
  - Use the `playwright-brave` MCP: `browser_navigate`, then `browser_snapshot`, then `browser_click`/`browser_type`.
  - Prefer an accessibility snapshot of a specific element over full-page snapshots or screenshots. Close tabs you no longer need.
  - It drives the owner's real Brave profile, with signed-in accounts. Stay on the pages the task needs, and never submit forms, sign in, change settings, or trigger builds or deploys from the browser without owner approval.
- The mobile app runs on a real phone, not in a browser. Phone checks are done by the owner, or with `adb` over USB as described in AGENTS.md.
- Use the todo list for multi-step work, so the plan survives compaction.
- Durable facts you had to discover the hard way (gotchas, commands, decisions) go in `/memories/repo/` as one-line bullets. Check there before re-investigating. If a fact changes the project map above, update the map instead.
- At the start of a task, if `/memories/repo/progress.md` exists and relates to the task, read it and continue from it.

## Self-checkpointing and compaction
- Checkpoint on your own, without waiting to be asked, after any major change:
  - a feature or milestone is finished and verified
  - a schema, API, or data-model change
  - a review verdict that changes direction
  - you've edited 4 or more files since the last checkpoint
  - right before starting a big new phase

  To checkpoint, read `.github/prompts/checkpoint.prompt.md` and follow its steps, but skip its final reply line. Don't checkpoint after small edits.
- You can't run `/compact` yourself. When you've just checkpointed and the next step doesn't need the earlier file contents or tool output from this chat, end your reply with: `Progress saved. Safe to /compact.` Otherwise don't suggest it.
