import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { formatPairingLink, newPairingSecret, normalizeRelayUrl } from '@heyloop/protocol/crypto';
import { loadConfig, saveConfig, type Config } from './config.js';
import { startDaemon } from './server.js';

const USAGE = `heyloop <command>

  start                         Run the daemon (MCP server + local API)
  token                         Print the daemon token for MCP clients
  setup vscode [dir]            Add HeyLoop to <dir>/.vscode/mcp.json (default: current folder)
  pair --relay <url>            Create a new phone pairing (replaces the old one)
  pair                          Show the current pairing QR code again
  unpair                        Remove the phone pairing
  chats                         List chats
  pending                       List pending approval requests
  answer <request_id> <option>  Answer with an option id (e.g. approve, reject)
  answer <request_id> --text "..."
  say <chat_id> <text...>       Send a message to an agent's inbox`;

const VSCODE_NOTICE = `
Heads-up: VS Code asks for confirmation itself
  Copilot shows its own "Allow" prompt for terminal commands and tools. HeyLoop cannot
  see or answer those, so an unattended agent can stall on one.

  Recommended: auto-approve only safe commands in your VS Code settings, e.g.
    "chat.tools.terminal.enableAutoApprove": true,
    "chat.tools.terminal.autoApprove": {
      "/^git (status|diff|log|show|branch)\\\\b/": true,
      "/^npm (test|run (test|lint|typecheck|build))\\\\b/": true
    }
  Do NOT enable "chat.tools.global.autoApprove"; it disables every safety prompt.
  Leave risky commands to be approved through HeyLoop.
`;

async function api(config: Config, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.port}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('HeyLoop daemon is not running. Start it with: heyloop start');
  }
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function setupVscode(config: Config, dir: string): void {
  const vscodeDir = join(resolve(dir), '.vscode');
  const file = join(vscodeDir, 'mcp.json');
  const input = {
    type: 'promptString',
    id: 'heyloop-token',
    description: 'HeyLoop daemon token (run: heyloop token)',
    password: true,
  };
  const server = {
    type: 'http',
    url: `http://127.0.0.1:${config.port}/mcp`,
    headers: { Authorization: 'Bearer ${input:heyloop-token}' },
  };

  let doc: { inputs?: { id: string }[]; servers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      console.log(`${file} has comments or invalid JSON. Add this manually:\n`);
      console.log(JSON.stringify({ inputs: [input], servers: { heyloop: server } }, null, 2));
      console.log(VSCODE_NOTICE);
      return;
    }
  }
  doc.inputs = [...(doc.inputs ?? []).filter((i) => i.id !== input.id), input];
  doc.servers = { ...doc.servers, heyloop: server };
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`Wrote ${file}`);
  console.log('VS Code will ask for the token when the server starts. Get it with: heyloop token');
  console.log(VSCODE_NOTICE);
}

async function pair(config: Config, relayUrl: string | undefined): Promise<void> {
  if (relayUrl) {
    config.relay = { url: normalizeRelayUrl(relayUrl), secret: newPairingSecret() };
    saveConfig(config);
  }
  if (!config.relay) throw new Error('Not paired. Run: heyloop pair --relay <url>');

  const link = formatPairingLink({ relay: config.relay.url, secret: config.relay.secret, name: config.machine_name });
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }));
  console.log('Scan with the HeyLoop app. Treat this code like a password.');
  if (relayUrl) console.log('Restart the daemon to connect with the new pairing.');
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const config = loadConfig();

  switch (cmd) {
    case 'start': {
      const server = startDaemon(config);
      server.on('listening', () => {
        console.log(`HeyLoop daemon listening on http://127.0.0.1:${config.port}/mcp`);
      });
      server.on('error', (err) => {
        console.error(`Failed to start: ${err.message}`);
        process.exit(1);
      });
      return;
    }
    case 'token':
      console.log(config.token);
      return;
    case 'pair': {
      const i = rest.indexOf('--relay');
      await pair(config, i >= 0 ? rest[i + 1] : undefined);
      return;
    }
    case 'unpair':
      delete config.relay;
      saveConfig(config);
      console.log('Pairing removed. Restart the daemon to disconnect.');
      return;
    case 'setup':
      if (rest[0] !== 'vscode') throw new Error('Usage: heyloop setup vscode [dir]');
      setupVscode(config, rest[1] ?? process.cwd());
      return;
    case 'chats': {
      const chats = (await api(config, 'GET', '/chats')) as { chat_id: string; status: string; title: string }[];
      if (!chats.length) console.log('No chats yet.');
      for (const c of chats) console.log(`${c.chat_id}  ${c.status.padEnd(13)}  ${c.title}`);
      return;
    }
    case 'pending': {
      const items = (await api(config, 'GET', '/approvals')) as {
        request_id: string;
        chat_id: string;
        options: { id: string; label: string }[];
        request?: { question: string; command?: string; risk: string };
      }[];
      if (!items.length) console.log('No pending requests.');
      for (const a of items) {
        console.log(`${a.request_id}  [${a.request?.risk ?? '?'}]  ${a.request?.question ?? ''}`);
        if (a.request?.command) console.log(`    $ ${a.request.command}`);
        console.log(`    options: ${a.options.length ? a.options.map((o) => o.id).join(', ') : '--text "..."'}`);
      }
      return;
    }
    case 'answer': {
      const [requestId, ...tail] = rest;
      if (!requestId || !tail.length) throw new Error('Usage: heyloop answer <request_id> <option> | --text "..."');
      const body = tail[0] === '--text' ? { text: tail.slice(1).join(' ') } : { option_id: tail[0] };
      console.log(JSON.stringify(await api(config, 'POST', `/approvals/${encodeURIComponent(requestId)}/answer`, body)));
      return;
    }
    case 'say': {
      const [chatId, ...words] = rest;
      if (!chatId || !words.length) throw new Error('Usage: heyloop say <chat_id> <text...>');
      await api(config, 'POST', `/chats/${encodeURIComponent(chatId)}/messages`, { text: words.join(' ') });
      console.log('Sent. The agent receives it on its next send_status_update call.');
      return;
    }
    default:
      console.log(USAGE);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
