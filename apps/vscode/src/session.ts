import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PromptDelivered, SessionClaim } from '@heyloop/protocol';
import type { DaemonConfig } from './config.js';

export function sessionUriString(sessionId: string): string {
  const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
  return `vscode-chat-session://local/${encoded}`;
}

export const sessionUri = sessionUriString;

export function ownsSession(workspaceStorageDir: string | undefined, sessionId: string): boolean {
  if (!workspaceStorageDir || !sessionId) {
    return false;
  }
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0')
  ) {
    return false;
  }
  const sessionsDir = join(workspaceStorageDir, 'chatSessions');
  return (
    existsSync(join(sessionsDir, `${sessionId}.jsonl`)) ||
    existsSync(join(sessionsDir, `${sessionId}.json`))
  );
}

export interface DeliveredRequest {
  url: string;
  init: {
    method: 'POST';
    headers: {
      Authorization: string;
      'Content-Type': 'application/json';
    };
    body: string;
  };
}

export type ClaimRequest = DeliveredRequest;

export function buildDeliveredRequest(config: DaemonConfig, payload: PromptDelivered): DeliveredRequest {
  const body = PromptDelivered.parse(payload);
  const url = new URL('/api/windows/delivered', `http://127.0.0.1:${config.port}`).toString();
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  };
}

export async function postPromptDelivered(
  config: DaemonConfig,
  payload: PromptDelivered,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const req = buildDeliveredRequest(config, payload);
  const res = await fetchImpl(req.url, req.init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export function buildClaimRequest(config: DaemonConfig, payload: SessionClaim): ClaimRequest {
  const body = SessionClaim.parse(payload);
  const url = new URL('/api/windows/claim', `http://127.0.0.1:${config.port}`).toString();
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  };
}

export async function postSessionClaim(
  config: DaemonConfig,
  payload: SessionClaim,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const req = buildClaimRequest(config, payload);
  const res = await fetchImpl(req.url, req.init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

export function createPromptQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
