import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';

export interface Config {
  port: number;
  token: string;
  machine_id: string;
  machine_name: string;
  relay?: { url: string; secret: string };
}

export const DEFAULT_PORT = 4519;

export function dataDir(): string {
  return process.env.HEYLOOP_HOME ?? join(homedir(), '.heyloop');
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function loadConfig(): Config {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as Config;
  }
  const config: Config = {
    port: DEFAULT_PORT,
    token: randomBytes(32).toString('base64url'),
    machine_id: ulid(),
    machine_name: hostname(),
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

export function saveConfig(config: Config): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
