# HeyLoop

**Your agents keep working. You keep living.**

HeyLoop connects long-running AI coding agents on your computer to a phone experience: status updates, approval requests, and replies without staying at your desk. Local-first, self-hosted, and end-to-end encrypted between your devices.

[Website](https://californiaalmonds.github.io/heyloop/) · [Report an issue](https://github.com/californiaAlmonds/heyloop/issues)

## Status

Early development, not a finished mobile product.

| Component | Available today |
| --- | --- |
| Local daemon | MCP tools, SQLite history, approval broker, REST API, CLI |
| Relay | Cloudflare Worker + Durable Object, encrypted queues, QR pairing; tested locally |
| Android app | Expo scaffold linked to EAS; conversation and approval screens still to build |
| Push notifications | Planned; not implemented |

The website's phone illustration is a concept, not a released app screenshot.

## Quick Start

Requires **Node.js 22.13+**, npm, and an MCP-compatible client such as VS Code Copilot. Node's built-in SQLite may print an expected experimental warning.

```sh
git clone https://github.com/californiaAlmonds/heyloop.git
cd heyloop
npm install
npm run cli -w @heyloop/daemon -- start
```

The daemon listens only on `127.0.0.1:4519`. Configuration, token, and SQLite history live in `~/.heyloop`; `HEYLOOP_HOME` overrides that directory.

In a second terminal, configure the workspace where your agent works:

```sh
npm run cli -w @heyloop/daemon -- setup vscode /path/to/your/project
npm run cli -w @heyloop/daemon -- token
```

On Windows, use a path such as `"E:\my-project"`. The setup command adds the server to that workspace's `.vscode/mcp.json`. Enable HeyLoop in VS Code's MCP tools and supply the token when prompted. Keep the token private; do not paste it into an agent conversation or commit it.

Ask your agent to use HeyLoop for status updates and explicit approval requests. Available MCP tools:

| Tool | Purpose |
| --- | --- |
| `send_status_update` | Post progress and receive queued user messages |
| `ask_human_approval` | Ask for an answer; returns `pending` after at most 55 seconds |
| `await_human_response` | Continue waiting for a pending request |

**Important:** HeyLoop cannot see or answer VS Code's native **Allow** prompts. If you configure auto-approval, use a narrow allowlist for trusted commands. Never enable `chat.tools.global.autoApprove` as a workaround.

## Local Relay

Run the relay in another terminal:

```sh
npm run dev -w @heyloop/relay
```

Pair the daemon, then restart it:

```sh
npm run cli -w @heyloop/daemon -- pair --relay http://127.0.0.1:8787
```

The QR code contains a pairing secret. Treat it like a password. Plain HTTP is allowed only for loopback testing; real deployments require HTTPS. A physical phone cannot reach your computer through the phone's own loopback address. The phone UI is not ready yet; use the simulated-phone relay smoke test below.

To self-host the relay, configure your own Cloudflare account and deploy:

```sh
npm run deploy -w @heyloop/relay
```

Pair with the resulting HTTPS Worker URL and restart the daemon. No public inbound port or tunnel is needed on your computer.

## CLI

Run commands with `npm run cli -w @heyloop/daemon -- <command>`:

| Command | Purpose |
| --- | --- |
| `chats` | List conversations and status |
| `pending` | List approval requests, verbatim commands, and options |
| `answer <request_id> <option_id>` | Answer a pending request |
| `answer <request_id> --text "..."` | Send a free-text answer |
| `say <chat_id> <text...>` | Queue a message for the agent's next status call |
| `pair` | Show the existing pairing QR again |
| `unpair` | Remove pairing; restart the daemon afterward |

## How It Works

```text
Coding agent -- MCP --> Local daemon <-- encrypted WSS --> Relay <--> Phone
                        SQLite history                     ciphertext
```

- **Local ownership:** the daemon's SQLite database is the source of truth.
- **Private transport:** QR pairing exchanges a shared secret; tweetnacl secretbox encrypts app frames. The relay does not receive the encryption key or plaintext message content. It can observe connection and delivery metadata.
- **Safe approval lifecycle:** first answer wins, late answers return 409, and unanswered requests resolve to `on_timeout` (default `deny`). Commands are shown verbatim.
- **Reconnect support:** per-chat sequence cursors replay history from the daemon; the relay queues ciphertext until acknowledgement.
- **No HeyLoop accounts:** pairing identifies devices. Self-hosting still requires an account with your infrastructure provider.

## Development

Use `develop-californiaAlmonds` for the owner's ongoing work. GitHub restricts updates to this branch to the repository admin; in this personal repository, that is `californiaAlmonds`. Other contributors should work in their own branches or forks.

Changes to `main` require a pull request, an up-to-date branch, passing **Typecheck** and **Daemon smoke** checks, and resolved review conversations. Direct pushes, force pushes, and deletion are blocked, including for the owner. A second-person review is not required for this single-maintainer repository. The checks run for every PR to `main`, without path filters.

```sh
npm run typecheck
# With the daemon running:
npm run smoke -w @heyloop/daemon
# With the local relay running and daemon paired/restarted:
npm run smoke:relay -w @heyloop/daemon
```

Use a throwaway data directory for smoke tests. In PowerShell, set `$env:HEYLOOP_HOME = "$env:TEMP\heyloop-test"` in each relevant terminal before starting services or running tests. Do not test against your personal chat history.

| Directory | Responsibility |
| --- | --- |
| `packages/protocol` | Shared schemas, wire contracts, pairing, encryption |
| `apps/daemon` | MCP server, store, approvals, relay client, CLI |
| `apps/relay` | Cloudflare Worker and pairing-room Durable Objects |
| `apps/mobile` | Expo Android app scaffold |
| `docs/site` | Static GitHub Pages website; open `index.html` directly |

The Pages workflow deploys only `docs/site` on pushes to `main` that affect the site or workflow. GitHub Pages must use **GitHub Actions** as its publishing source. There is no website build step.

## Roadmap

- Android pairing, chat list, conversation view, replies, and approval sheet.
- Push notifications as a doorbell; messages remain encrypted and sync from the daemon.
- Desktop-first routing, presence, and stall nudges.
- Later: VS Code extension, SDK/CLI adapters, iOS, and remote MCP connectors.

See [project state](docs/context/state.md), [architecture](docs/context/architecture.md), and [decisions](docs/context/decisions.md) for implementation details. Contributions are welcome; open an issue before proposing a larger change. Never include tokens, pairing secrets, or cloud credentials in issues or pull requests.

## License

Package metadata declares MIT. A standalone license file is pending confirmation of the copyright holder; it has not been added yet.