import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonConfig {
  port: number;
  token: string;
}

export function dataDir(): string {
  const envHome = process.env.HEYLOOP_HOME?.trim();
  return envHome ? envHome : join(homedir(), '.heyloop');
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function loadConfig(path = configPath()): DaemonConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid HeyLoop config: expected JSON object');
  }
  const { port, token } = raw as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid HeyLoop config: "port" must be an integer between 1 and 65535');
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Invalid HeyLoop config: "token" must be a non-empty string');
  }
  return { port, token };
}
