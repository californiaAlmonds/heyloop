import { EventEmitter } from 'node:events';
import type { ExtensionEvent, WindowHello } from '@heyloop/protocol';
import type { Workspace } from '@heyloop/protocol/relay';
import type { Store } from './store.js';

interface ConnectedWindow extends WindowHello {
  write: (event: ExtensionEvent) => boolean | void;
  close?: () => void;
}

export class WindowRegistry extends EventEmitter<{ change: [] }> {
  private windows = new Map<string, ConnectedWindow>();

  constructor(private store?: Store) {
    super();
  }

  setStore(store: Store): void {
    this.store = store;
    for (const win of this.windows.values()) {
      store.upsertWorkspace(win.workspace, win.name, win.folder);
    }
  }

  get size(): number {
    return this.windows.size;
  }

  register(window: WindowHello, write: (event: ExtensionEvent) => boolean | void, close?: () => void): () => void {
    this.store?.upsertWorkspace(window.workspace, window.name, window.folder);
    const prev = this.windows.get(window.id);
    const wasOpen = this.openWorkspaceIds().has(window.workspace);
    const entry: ConnectedWindow = {
      id: window.id,
      name: window.name,
      workspace: window.workspace,
      ...(window.folder ? { folder: window.folder } : {}),
      write,
      close,
    };
    this.windows.set(window.id, entry);
    prev?.close?.();
    const prevClosed = prev !== undefined && prev.workspace !== window.workspace && !this.openWorkspaceIds().has(prev.workspace);
    if (!wasOpen || prevClosed || (prev !== undefined && prev.name !== window.name)) {
      this.emit('change');
    }
    return () => {
      if (this.windows.get(window.id) !== entry) return;
      this.windows.delete(window.id);
      if (!this.openWorkspaceIds().has(window.workspace)) {
        this.emit('change');
      }
    };
  }

  has(id: string): boolean {
    return this.windows.has(id);
  }

  get(id: string): WindowHello | undefined {
    const win = this.windows.get(id);
    if (!win) return undefined;
    return {
      id: win.id,
      name: win.name,
      workspace: win.workspace,
      ...(win.folder ? { folder: win.folder } : {}),
    };
  }

  workspaceForWindow(id: string): string | undefined {
    return this.windows.get(id)?.workspace;
  }

  openWorkspaceIds(): Set<string> {
    const ids = new Set<string>();
    for (const win of this.windows.values()) {
      ids.add(win.workspace);
    }
    return ids;
  }

  windowForWorkspace(workspaceId: string): WindowHello | undefined {
    for (const win of this.windows.values()) {
      if (win.workspace === workspaceId) {
        return {
          id: win.id,
          name: win.name,
          workspace: win.workspace,
          ...(win.folder ? { folder: win.folder } : {}),
        };
      }
    }
    return undefined;
  }

  workspaces(): Workspace[] {
    const openIds = this.openWorkspaceIds();
    const stored = this.store?.listWorkspaces() ?? [];
    const seen = new Set<string>();
    const result: Workspace[] = [];
    for (const ws of stored) {
      seen.add(ws.id);
      result.push({ id: ws.id, name: ws.name, open: openIds.has(ws.id) });
    }
    for (const win of this.windows.values()) {
      if (!seen.has(win.workspace)) {
        seen.add(win.workspace);
        result.push({ id: win.workspace, name: win.name, open: true });
      }
    }
    return result;
  }

  list(): WindowHello[] {
    return Array.from(this.windows.values(), ({ id, name, workspace, folder }) => ({
      id,
      name,
      workspace,
      ...(folder ? { folder } : {}),
    }));
  }

  send(id: string, event: ExtensionEvent): boolean {
    const win = this.windows.get(id);
    if (!win) return false;
    return win.write(event) !== false;
  }

  sendToWorkspace(workspaceId: string, event: ExtensionEvent): void {
    for (const win of this.windows.values()) {
      if (win.workspace === workspaceId) {
        win.write(event);
      }
    }
  }

  broadcast(event: ExtensionEvent): void {
    for (const win of this.windows.values()) {
      win.write(event);
    }
  }
}
