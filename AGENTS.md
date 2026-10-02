# HeyLoop — Agent Guide

HeyLoop connects long-running AI coding agents on a computer to a Telegram-style phone app: agents post status, ask for approvals, and receive messages; the user answers from desktop or phone. Open source, self-hosted, local-first.

## Start every session here
1. Read [docs/context/state.md](docs/context/state.md) — current phase, what works, what's next. Trust it; don't re-explore code it already describes.
2. Read [docs/context/architecture.md](docs/context/architecture.md) or [docs/context/decisions.md](docs/context/decisions.md) only when the task touches design or revisits a past choice.
3. Never reverse a logged decision silently. If a change conflicts with one, say so and propose an updated entry.

## Working style
- Act, don't narrate. Gather just enough context, then implement. Prefer targeted `grep`/file reads over broad exploration; batch independent reads in parallel.
- Smallest change that fully solves the task. No speculative features, abstractions, or dependencies.
- When a product decision is genuinely needed, give options with a clear recommendation instead of open-ended questions.
- Verify before reporting done: `npm run typecheck`, plus the smoke test when daemon behavior changes.
- Keep replies short: what changed, how it was verified, what's next.

## Build and test
- Install: `npm install` (npm workspaces; pnpm is not used)
- Typecheck: `npm run typecheck`
- Run daemon: `npm run cli -w @heyloop/daemon -- start`
- Smoke test (daemon running): `npm run smoke -w @heyloop/daemon`
- Relay locally: `npm run dev -w @heyloop/relay` (port 8787, no Cloudflare account needed); pair a test home with `heyloop pair --relay http://127.0.0.1:8787`, restart the daemon, then `npm run smoke:relay -w @heyloop/daemon`.
- Use a throwaway data dir for tests: `$env:HEYLOOP_HOME = "$env:TEMP\heyloop-test"`; delete it afterwards.
- Shell is Windows PowerShell 5.1: chain with `;`, never `&&`.

## Layout
- `packages/protocol` — zod schemas for messages and MCP tool contracts (`.`), relay/app frames (`./relay`), pairing + encryption (`./crypto`, tweetnacl). **Single source of truth**: change contracts here first, then implementations. Don't re-export `relay`/`crypto` from `index.ts` (circular import).
- `apps/daemon` — MCP server (Streamable HTTP), SQLite store, approval broker, local REST API, relay client, CLI.
- `apps/relay` — Cloudflare Worker + SQLite-backed Durable Object per pairing room; forwards and queues ciphertext.
- Planned: `apps/mobile` (Expo, Android first).

## Conventions
- TypeScript strict, ESM, `moduleResolution: NodeNext` — relative imports use `.js` extensions. Run TS directly with `tsx`; packages export `src/*.ts`.
- zod v4, `@modelcontextprotocol/sdk` 1.31, Node 22.13+ built-in `node:sqlite` (no native deps).
- Comments only for what code can't say, one short line.
- Commits follow Conventional Commits (`feat(daemon): ...`, `fix(protocol): ...`).

## Security rules (do not weaken)
- Daemon binds `127.0.0.1` only, requires the bearer token, and enforces the Host allowlist (DNS-rebinding protection). Never log or commit the token.
- The relay must only ever see ciphertext; pairing keys are exchanged via QR.
- Unanswered approvals resolve to `on_timeout` (default `deny`). First answer wins; late answers get 409.
- Always show `command` verbatim to the user; summaries can be manipulated by repo content.

## Gotchas
- Tool handler context type: `RequestHandlerExtra<ServerRequest, ServerNotification>`; desktop prompts use `extra.sendRequest(elicitation/create)` so they bind to the tool call.
- HeyLoop tools set `readOnlyHint: true` so VS Code doesn't confirm each call; `openWorldHint: true` would make VS Code confirm results.
- VS Code's own "Allow" prompts are invisible to HeyLoop. Settings: `chat.tools.terminal.enableAutoApprove`, `chat.tools.terminal.autoApprove`; warn against `chat.tools.global.autoApprove`.
- `node:sqlite` prints an ExperimentalWarning — expected.
- After moving/renaming the repo folder, run `npm install` to fix workspace symlinks before typechecking.

## Context tracking (required)
At the end of every task that changes code, design, or plans, update `docs/context/` before replying (or run `/wrap-up`):
- `state.md` — rewrite to reflect reality; keep under ~60 lines.
- `decisions.md` — append one line per new decision: date, decision, short why.
- `architecture.md` — only when components or contracts change.
These files replace chat history between sessions; keep them accurate and terse.
