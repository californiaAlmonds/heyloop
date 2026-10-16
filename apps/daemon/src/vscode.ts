import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_INSTRUCTIONS, MANAGED_COMMENT } from './agent-instructions.js';
import type { Config } from './config.js';

export const VSCODE_NOTICE = `
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

export function vscodeUserDir(): string {
  if (process.env.HEYLOOP_VSCODE_USER_DIR) return process.env.HEYLOOP_VSCODE_USER_DIR;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return join(homedir(), '.config', 'Code', 'User');
}

export function userMcpJsonPath(): string {
  return join(vscodeUserDir(), 'mcp.json');
}

export function userInstructionsPath(): string {
  return join(vscodeUserDir(), 'prompts', 'heyloop.instructions.md');
}

/** Pass `token` only for the user-level file (never committed); workspace files get a password prompt instead. */
export function writeMcpJson(file: string, port: number, token?: string): boolean {
  const input = {
    type: 'promptString',
    id: 'heyloop-token',
    description: 'HeyLoop daemon token (run: heyloop token)',
    password: true,
  };
  const server = {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: token ? `Bearer ${token}` : 'Bearer ${input:heyloop-token}' },
  };

  let doc: { inputs?: { id: string }[]; servers?: Record<string, unknown> } = {};
  const manual = (why: string) => {
    const shown = token ? { servers: { heyloop: { ...server, headers: { Authorization: 'Bearer <output of: heyloop token>' } } } } : { inputs: [input], servers: { heyloop: server } };
    console.log(`${file} ${why}. Add this manually:\n`);
    console.log(JSON.stringify(shown, null, 2));
    return false;
  };
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return manual('has comments or invalid JSON');
    }
    const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(doc) || (doc.inputs !== undefined && !Array.isArray(doc.inputs)) || (doc.servers !== undefined && !isObj(doc.servers))) {
      return manual('has an unexpected shape');
    }
  }
  const otherInputs = (doc.inputs ?? []).filter((i) => i.id !== input.id);
  doc.inputs = token ? otherInputs : [...otherInputs, input];
  if (!doc.inputs.length) delete doc.inputs;
  doc.servers = { ...doc.servers, heyloop: server };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`Wrote ${file}`);
  if (!token) console.log('VS Code will ask for the token when the server starts. Get it with: heyloop token');
  return true;
}

export function setupVscodeWorkspace(config: Config, dir: string): void {
  const file = join(resolve(dir), '.vscode', 'mcp.json');
  writeMcpJson(file, config.port);
  console.log(VSCODE_NOTICE);
}

export function setupVscodeUser(config: Config): void {
  writeMcpJson(userMcpJsonPath(), config.port, config.token);

  const instructionsFile = userInstructionsPath();
  if (existsSync(instructionsFile) && !readFileSync(instructionsFile, 'utf8').includes(MANAGED_COMMENT)) {
    console.log(`Skipped ${instructionsFile} (existing file is not managed by HeyLoop)`);
  } else {
    mkdirSync(dirname(instructionsFile), { recursive: true });
    writeFileSync(instructionsFile, AGENT_INSTRUCTIONS);
    console.log(`Wrote ${instructionsFile}`);
  }
  console.log(VSCODE_NOTICE);
}

export function hasUserMcpServer(): boolean {
  const file = userMcpJsonPath();
  if (!existsSync(file)) return false;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { servers?: Record<string, unknown> };
    return Boolean(doc?.servers?.heyloop);
  } catch {
    return false;
  }
}

export function hasUserInstructions(): boolean {
  return existsSync(userInstructionsPath());
}
