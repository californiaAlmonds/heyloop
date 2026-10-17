import { createHash } from 'node:crypto';
import { WindowHello } from '@heyloop/protocol';

export interface WorkspaceInput {
  workspaceFile?: string | undefined;
  folders: readonly string[];
}

export function workspaceKey(input: WorkspaceInput): string | undefined {
  // Untitled multi-root workspaces get a new untitled: URI per session, so key them by their folders instead.
  if (input.workspaceFile && !input.workspaceFile.startsWith('untitled:')) {
    return createHash('sha256').update(input.workspaceFile, 'utf8').digest('hex').slice(0, 32);
  }
  if (input.folders.length === 0) {
    return undefined;
  }
  const canonical = [...input.folders].sort().join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

export function eventsUrl(port: number, hello: WindowHello): string {
  const parsed = WindowHello.parse(hello);
  const url = new URL('/api/windows/events', `http://127.0.0.1:${port}`);
  url.searchParams.set('id', parsed.id);
  url.searchParams.set('name', parsed.name);
  url.searchParams.set('workspace', parsed.workspace);
  if (parsed.folder !== undefined) {
    url.searchParams.set('folder', parsed.folder);
  }
  return url.toString();
}
