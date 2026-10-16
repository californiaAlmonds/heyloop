import { dirname } from 'node:path';
import { ExtensionEvent } from '@heyloop/protocol';
import * as vscode from 'vscode';
import { type DaemonConfig, loadConfig } from './config.js';
import { createPromptQueue, ownsSession, postPromptDelivered, sessionUriString } from './session.js';
import { SseParser } from './sse.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

let activeCleanup: (() => void) | undefined;

interface EventContext {
  config: DaemonConfig;
  windowId: string;
  workspaceStorageDir: string | undefined;
  enqueuePrompt: <T>(task: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
}

async function handleEvent(rawData: string, ctx: EventContext): Promise<void> {
  const { log } = ctx;
  let json: unknown;
  try {
    json = JSON.parse(rawData);
  } catch {
    log('Ignored non-JSON SSE event');
    return;
  }

  const parsed = ExtensionEvent.safeParse(json);
  if (!parsed.success) {
    log('Ignored unrecognized SSE event payload');
    return;
  }

  const event = parsed.data;
  if (event.type === 'new_chat') {
    log(`Opening new Copilot chat for chat_id=${event.chat_id}`);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: event.prompt,
        mode: 'agent',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to open Copilot chat: ${msg}`);
    }
  } else if (event.type === 'prompt') {
    if (!ownsSession(ctx.workspaceStorageDir, event.session_id)) {
      return;
    }
    await ctx.enqueuePrompt(async () => {
      log(`Delivering prompt message_id=${event.message_id} to session_id=${event.session_id}`);
      try {
        const uri = vscode.Uri.parse(sessionUriString(event.session_id));
        await vscode.commands.executeCommand('vscode.open', uri);
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: event.text,
        });
        await postPromptDelivered(ctx.config, {
          message_id: event.message_id,
          window_id: ctx.windowId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to deliver prompt message_id=${event.message_id}: ${msg}`);
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('HeyLoop');
  const log = (msg: string): void => {
    output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'heyloop.reconnect';

  const setStatus = (connected: boolean, detail?: string): void => {
    if (connected) {
      statusBar.text = '$(plug) HeyLoop';
      statusBar.tooltip = detail
        ? `HeyLoop: Connected (${detail}) — click to reconnect`
        : 'HeyLoop: Connected to local daemon — click to reconnect';
    } else {
      statusBar.text = '$(debug-disconnect) HeyLoop';
      statusBar.tooltip = detail
        ? `HeyLoop: Disconnected (${detail}) — click to reconnect`
        : 'HeyLoop: Disconnected from local daemon — click to reconnect';
    }
  };

  setStatus(false, 'connecting');
  statusBar.show();

  let disposed = false;
  let currentAbort: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeSleep: (() => void) | undefined;
  let backoffMs = INITIAL_BACKOFF_MS;
  let manualReconnectRequested = false;

  const triggerReconnect = (reason: string): void => {
    if (disposed) {
      return;
    }
    log(`Reconnecting (${reason})`);
    manualReconnectRequested = true;
    backoffMs = INITIAL_BACKOFF_MS;
    currentAbort?.abort();
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    wakeSleep?.();
  };

  const cleanup = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    currentAbort?.abort();
    currentAbort = undefined;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    wakeSleep?.();
  };

  activeCleanup = cleanup;

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('heyloop.reconnect', () => triggerReconnect('command')),
    vscode.workspace.onDidChangeWorkspaceFolders(() => triggerReconnect('workspace folders changed')),
    new vscode.Disposable(cleanup),
  );

  const enqueuePrompt = createPromptQueue();

  const runLoop = async (): Promise<void> => {
    while (!disposed) {
      manualReconnectRequested = false;
      const controller = new AbortController();
      currentAbort = controller;

      try {
        const config = loadConfig();
        const windowId = vscode.env.sessionId.slice(0, 64);
        const windowName = (vscode.workspace.name ?? 'Untitled window').slice(0, 120);
        const workspaceStorageDir = context.storageUri ? dirname(context.storageUri.fsPath) : undefined;
        const eventCtx: EventContext = {
          config,
          windowId,
          workspaceStorageDir,
          enqueuePrompt,
          log,
        };
        const url = new URL('/api/windows/events', `http://127.0.0.1:${config.port}`);
        url.searchParams.set('id', windowId);
        url.searchParams.set('name', windowName);

        log(`Connecting to 127.0.0.1:${config.port} as "${windowName}" (${windowId})`);
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        backoffMs = INITIAL_BACKOFF_MS;
        setStatus(true, `127.0.0.1:${config.port}`);
        log(`Connected to 127.0.0.1:${config.port}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();

        while (!controller.signal.aborted && !disposed) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          for (const data of parser.feed(chunk)) {
            await handleEvent(data, eventCtx);
          }
        }

        const tail = decoder.decode();
        if (tail) {
          for (const data of parser.feed(tail)) {
            await handleEvent(data, eventCtx);
          }
        }

        if (!controller.signal.aborted && !disposed) {
          setStatus(false, 'stream closed');
          log('SSE stream closed by daemon');
        }
      } catch (err) {
        if (!controller.signal.aborted && !disposed) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(false, msg);
          log(`Connection error: ${msg}`);
        }
      } finally {
        if (currentAbort === controller) {
          currentAbort = undefined;
        }
      }

      if (disposed) {
        break;
      }
      if (manualReconnectRequested) {
        continue;
      }

      const waitMs = backoffMs;
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      await new Promise<void>((resolve) => {
        wakeSleep = () => {
          wakeSleep = undefined;
          resolve();
        };
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          wakeSleep = undefined;
          resolve();
        }, waitMs);
      });
    }
  };

  void runLoop();
}

export function deactivate(): void {
  activeCleanup?.();
  activeCleanup = undefined;
}
