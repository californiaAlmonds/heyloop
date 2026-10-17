import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Chat, ExtensionEvent } from '@heyloop/protocol';
import { ApprovalBroker } from '../src/broker.js';
import { createMcpServer } from '../src/mcp.js';
import { Store } from '../src/store.js';
import { WindowRegistry } from '../src/windows.js';

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heyloop-test-'));
    try {
      await fn(dir);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // SQLite WAL files on Windows may remain locked until process exit.
      }
    }
  };
}

describe('Store chat_key, workspace_id, workspaces table, and migration', () => {
  it(
    'migrates an existing database, persists workspaces, tracks workspace_id on chats, and queries sessions and unconsumed inbox',
    withTempDir((dir) => {
      const dbPath = join(dir, 'heyloop.db');
      const oldDb = new DatabaseSync(dbPath);
      oldDb.exec(`
        CREATE TABLE chats (
          chat_id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          title_locked INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          last_heartbeat TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      oldDb
        .prepare('INSERT INTO chats VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
        .run('old-1', 'm1', 'vscode', 'Old chat', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      oldDb.close();

      const store = new Store(dir, 'm1');
      assert.equal(store.getChat('old-1')?.title, 'Old chat');
      assert.equal(store.getChat('old-1')?.workspace_id, undefined);
      assert.equal('workspace_id' in store.getChat('old-1')!, false);

      const c1 = store.createChat('vscode', 'Task A', 'ws:task-a');
      assert.equal(store.getChatByKey('ws:task-a')?.chat_id, c1.chat_id);
      assert.equal('chat_key' in c1, false);
      assert.equal('workspace_id' in c1, false);

      // createChat with workspace_id includes workspace_id in returned Chat and toChat
      const cWithWs = store.createChat('vscode', 'Task B', 'ws:task-b', 'aaaa1111');
      assert.equal(cWithWs.workspace_id, 'aaaa1111');
      assert.equal(store.getChat(cWithWs.chat_id)?.workspace_id, 'aaaa1111');
      assert.equal(store.getChatWorkspace(cWithWs.chat_id), 'aaaa1111');

      // Multiple chats with no chat_key are allowed by the partial unique index.
      const u1 = store.createChat('vscode', 'Untitled 1');
      const u2 = store.createChat('vscode', 'Untitled 2');
      assert.notEqual(u1.chat_id, u2.chat_id);

      // Duplicate non-null chat_key is rejected.
      assert.throws(() => store.createChat('vscode', 'Duplicate', 'ws:task-a'));

      // vscode_session_id is migrated and starts undefined, then can be set and updated.
      assert.equal(store.getVscodeSession('old-1'), undefined);
      store.setVscodeSession('old-1', 'sess-1');
      assert.equal(store.getVscodeSession('old-1'), 'sess-1');
      store.setVscodeSession('old-1', 'sess-2');
      assert.equal(store.getVscodeSession('old-1'), 'sess-2');

      // unclaimedSessions lists sessions on chats without workspace_id; setChatWorkspace sets workspace_id once and emits chat event.
      store.setVscodeSession(cWithWs.chat_id, 'sess-claimed');
      assert.deepEqual(store.unclaimedSessions(), ['sess-2']);

      const emittedChats: Chat[] = [];
      store.on('chat', (c) => emittedChats.push(c));
      assert.equal(store.setChatWorkspace('old-1', 'bbbb2222'), true);
      assert.equal(store.getChatWorkspace('old-1'), 'bbbb2222');
      assert.equal(store.getChat('old-1')?.workspace_id, 'bbbb2222');
      assert.equal(emittedChats.length, 1);
      assert.equal(emittedChats[0]?.workspace_id, 'bbbb2222');

      // Setting workspace_id again does not overwrite an existing workspace_id.
      assert.equal(store.setChatWorkspace('old-1', 'cccc3333'), false);
      assert.equal(store.getChatWorkspace('old-1'), 'bbbb2222');
      assert.equal(emittedChats.length, 1);
      assert.deepEqual(store.unclaimedSessions(), []);

      // Queries by vscode session id and workspace id.
      assert.deepEqual(
        store.chatsByVscodeSession('sess-2').map((c) => c.chat_id),
        ['old-1'],
      );
      assert.deepEqual(
        store.chatsByWorkspace('bbbb2222').map((c) => c.chat_id),
        ['old-1'],
      );

      // Workspaces upsert and persistence across Store reopen.
      store.upsertWorkspace('aaaa1111', 'first-name', '/path/one');
      store.upsertWorkspace('bbbb2222', 'second-ws');
      store.upsertWorkspace('aaaa1111', 'updated-name');
      assert.equal(store.getWorkspace('aaaa1111')?.name, 'updated-name');
      assert.equal(store.getWorkspace('aaaa1111')?.folder, '/path/one');
      assert.equal(store.getWorkspace('bbbb2222')?.folder, undefined);

      const reopened = new Store(dir, 'm1');
      assert.equal(reopened.listWorkspaces().length, 2);
      assert.equal(reopened.getWorkspace('aaaa1111')?.name, 'updated-name');
      assert.equal(reopened.getWorkspace('aaaa1111')?.folder, '/path/one');
      assert.equal(reopened.getChat('old-1')?.workspace_id, 'bbbb2222');

      // peekInbox returns unconsumed user text messages in seq order without consuming; markConsumed marks one; takeInbox consumes rest.
      const agentMsg = store.append('old-1', 'agent', {
        kind: 'status',
        summary: 'hi',
        level: 'info',
        notify: false,
      });
      const userMsg1 = store.append('old-1', 'user', { kind: 'text', text: 'hello 1' });
      const userMsg2 = store.append('old-1', 'user', { kind: 'text', text: 'hello 2' });
      assert.deepEqual(
        store.peekInbox('old-1').map((m) => m.text),
        ['hello 1', 'hello 2'],
      );
      assert.equal(store.hasMessage(agentMsg.id), true);
      assert.equal(store.hasMessage(userMsg1.id), true);
      assert.equal(store.hasMessage('missing-msg'), false);
      assert.equal(store.markConsumed('missing-msg'), false);
      assert.equal(store.markConsumed(agentMsg.id), false);
      assert.equal(store.markConsumed(userMsg1.id), true);
      assert.equal(store.markConsumed(userMsg1.id), false);
      assert.deepEqual(
        store.peekInbox('old-1').map((m) => m.text),
        ['hello 2'],
      );
      assert.deepEqual(
        store.takeInbox('old-1').map((m) => m.text),
        ['hello 2'],
      );
      assert.deepEqual(store.takeInbox('old-1'), []);
    }),
  );
});

describe('MCP chat_key resolution, inbox delivery, and whose_session broadcast', () => {
  it(
    'reuses chat_key, prioritizes chat_id over chat_key, delivers inbox once, and broadcasts whose_session for unclaimed chats',
    withTempDir(async (dir) => {
      const store = new Store(dir, 'm1');
      const broker = new ApprovalBroker(store);
      const windows = new WindowRegistry(store);
      const broadcastEvents: ExtensionEvent[] = [];
      windows.register({ id: 'w1', name: 'proj', workspace: 'aaaa1111' }, (ev) => broadcastEvents.push(ev));

      const mcp = createMcpServer(store, broker, windows);
      const client = new Client({ name: 'vscode', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

      const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args, _meta: meta })).structuredContent as Record<string, any>;

      // Same chat_key twice -> same chat_id
      const r1 = await call('send_status_update', {
        chat_key: 'repo:feature-1',
        title: 'Feature 1',
        summary: 'Step 1',
        level: 'info',
      });
      const r2 = await call('send_status_update', {
        chat_key: 'repo:feature-1',
        summary: 'Step 2',
        level: 'progress',
      });
      assert.equal(r1.chat_id, r2.chat_id);

      // Different chat_key -> different chat_id
      const r3 = await call('send_status_update', {
        chat_key: 'repo:feature-2',
        title: 'Feature 2',
        summary: 'Step 1',
        level: 'info',
      });
      assert.notEqual(r3.chat_id, r1.chat_id);

      // chat_id wins over chat_key
      const r4 = await call('send_status_update', {
        chat_id: r1.chat_id,
        chat_key: 'repo:feature-2',
        summary: 'Explicit chat_id wins',
        level: 'info',
      });
      assert.equal(r4.chat_id, r1.chat_id);

      // check_inbox consumes user messages once
      store.append(r1.chat_id, 'user', { kind: 'text', text: 'msg for check_inbox' });
      const inbox1 = await call('check_inbox', { chat_id: r1.chat_id });
      assert.equal(inbox1.inbox.length, 1);
      assert.equal(inbox1.inbox[0].text, 'msg for check_inbox');
      const inbox2 = await call('check_inbox', { chat_id: r1.chat_id });
      assert.equal(inbox2.inbox.length, 0);

      // check_inbox resolves by chat_key too
      store.append(r3.chat_id, 'user', { kind: 'text', text: 'msg by key' });
      const byKey = await call('check_inbox', { chat_key: 'repo:feature-2' });
      assert.equal(byKey.chat_id, r3.chat_id);
      assert.equal(byKey.inbox[0].text, 'msg by key');

      // Pending results keep the inbox; it is delivered once with the final answer
      store.append(r1.chat_id, 'user', { kind: 'text', text: 'msg before ask' });
      const ask = await call('ask_human_approval', {
        chat_key: 'repo:feature-1',
        question: 'Proceed?',
        risk: 'low',
        input: 'confirm',
        wait_seconds: 0,
      });
      assert.equal(ask.chat_id, r1.chat_id);
      assert.equal(ask.status, 'pending');
      assert.equal(ask.inbox, undefined);

      const stillPending = await call('await_human_response', { request_id: ask.request_id, wait_seconds: 0 });
      assert.equal(stillPending.status, 'pending');
      assert.equal(stillPending.inbox, undefined);

      store.append(r1.chat_id, 'user', { kind: 'text', text: 'msg before await' });
      broker.answer(ask.request_id, { option_id: 'approve' }, 'phone');
      const awaited = await call('await_human_response', {
        request_id: ask.request_id,
        wait_seconds: 0,
      });
      assert.equal(awaited.status, 'answered');
      assert.deepEqual(
        awaited.inbox.map((m: { text: string }) => m.text),
        ['msg before ask', 'msg before await'],
      );

      // Captures _meta["vscode.conversationId"] on all four tools, broadcasts whose_session when chat has no workspace_id.
      assert.equal(store.getVscodeSession(r1.chat_id), undefined);
      await call(
        'send_status_update',
        { chat_id: r1.chat_id, summary: 'With session 1', level: 'info' },
        { 'vscode.conversationId': 'dc621762-e451-4fab-ab81-c6be84cb738e' },
      );
      assert.equal(store.getVscodeSession(r1.chat_id), 'dc621762-e451-4fab-ab81-c6be84cb738e');
      assert.deepEqual(broadcastEvents, [{ type: 'whose_session', session_id: 'dc621762-e451-4fab-ab81-c6be84cb738e' }]);

      // Repeating the same session id does not broadcast again.
      await call(
        'check_inbox',
        { chat_id: r1.chat_id },
        { 'vscode.conversationId': 'dc621762-e451-4fab-ab81-c6be84cb738e' },
      );
      assert.equal(broadcastEvents.length, 1);

      // Invalid session ids are ignored and do not overwrite existing session id.
      await call(
        'check_inbox',
        { chat_id: r1.chat_id },
        { 'vscode.conversationId': 'bad id with spaces!' },
      );
      await call(
        'check_inbox',
        { chat_id: r1.chat_id },
        { 'vscode.conversationId': 'a'.repeat(129) },
      );
      assert.equal(store.getVscodeSession(r1.chat_id), 'dc621762-e451-4fab-ab81-c6be84cb738e');

      // Later call with a different valid id updates it and broadcasts whose_session while chat still has no workspace_id.
      await call('check_inbox', { chat_id: r1.chat_id }, { 'vscode.conversationId': 'session_2-abc' });
      assert.equal(store.getVscodeSession(r1.chat_id), 'session_2-abc');
      assert.equal(broadcastEvents.length, 2);
      assert.deepEqual(broadcastEvents[1], { type: 'whose_session', session_id: 'session_2-abc' });

      // Once workspace_id is set on the chat, a new session id updates vscode_session_id without broadcasting whose_session.
      store.setChatWorkspace(r1.chat_id, 'aaaa1111');
      const ask2 = await call(
        'ask_human_approval',
        { chat_id: r1.chat_id, question: 'Deploy?', risk: 'low', input: 'confirm', wait_seconds: 0 },
        { 'vscode.conversationId': 'session_3-def' },
      );
      assert.equal(store.getVscodeSession(r1.chat_id), 'session_3-def');
      assert.equal(broadcastEvents.length, 2);

      await call(
        'await_human_response',
        { request_id: ask2.request_id, wait_seconds: 0 },
        { 'vscode.conversationId': 'session_4-ghi' },
      );
      assert.equal(store.getVscodeSession(r1.chat_id), 'session_4-ghi');
      assert.equal(broadcastEvents.length, 2);

      await client.close();
    }),
  );
});
