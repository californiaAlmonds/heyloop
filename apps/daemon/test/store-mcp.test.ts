import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApprovalBroker } from '../src/broker.js';
import { createMcpServer } from '../src/mcp.js';
import { Store } from '../src/store.js';

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

describe('Store chat_key and migration', () => {
  it(
    'migrates an existing database without chat_key column and enforces unique partial index',
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

      const c1 = store.createChat('vscode', 'Task A', 'ws:task-a');
      assert.equal(store.getChatByKey('ws:task-a')?.chat_id, c1.chat_id);
      assert.equal('chat_key' in c1, false);

      // Multiple chats with no chat_key are allowed by the partial unique index.
      const u1 = store.createChat('vscode', 'Untitled 1');
      const u2 = store.createChat('vscode', 'Untitled 2');
      assert.notEqual(u1.chat_id, u2.chat_id);

      // Duplicate non-null chat_key is rejected.
      assert.throws(() => store.createChat('vscode', 'Duplicate', 'ws:task-a'));
    }),
  );
});

describe('MCP chat_key resolution and inbox delivery', () => {
  it(
    'reuses chat_key, prioritizes chat_id over chat_key, and delivers inbox once across tools',
    withTempDir(async (dir) => {
      const store = new Store(dir, 'm1');
      const broker = new ApprovalBroker(store);
      const mcp = createMcpServer(store, broker);
      const client = new Client({ name: 'vscode', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

      const call = async (name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

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

      await client.close();
    }),
  );
});
