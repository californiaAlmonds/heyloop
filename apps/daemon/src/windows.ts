import { EventEmitter } from 'node:events';
import type { ExtensionEvent } from '@heyloop/protocol';
import type { Workspace } from '@heyloop/protocol/relay';

interface ConnectedWindow extends Workspace {
  write: (event: ExtensionEvent) => void;
  close?: () => void;
}

export class WindowRegistry extends EventEmitter<{ change: [] }> {
  private windows = new Map<string, ConnectedWindow>();

  register(workspace: Workspace, write: (event: ExtensionEvent) => void, close?: () => void): () => void {
    const prev = this.windows.get(workspace.id);
    const entry: ConnectedWindow = { id: workspace.id, name: workspace.name, write, close };
    this.windows.set(workspace.id, entry);
    prev?.close?.();
    this.emit('change');
    return () => {
      if (this.windows.get(workspace.id) !== entry) return;
      this.windows.delete(workspace.id);
      this.emit('change');
    };
  }

  has(id: string): boolean {
    return this.windows.has(id);
  }

  list(): Workspace[] {
    return Array.from(this.windows.values(), ({ id, name }) => ({ id, name }));
  }

  send(id: string, event: ExtensionEvent): boolean {
    const win = this.windows.get(id);
    if (!win) return false;
    win.write(event);
    return true;
  }
}
