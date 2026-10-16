import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ExtensionEvent, type Chat, type Envelope } from '@heyloop/protocol';
import { deriveKeys, newPairingSecret, open, seal } from '@heyloop/protocol/crypto';
import { DaemonFrame, MAX_FRAME_CHARS } from '@heyloop/protocol/relay';
import { ApprovalBroker } from '../src/broker.js';
import { RelayClient, batchChats, batchEnvelopes } from '../src/relay-client.js';
import { startDaemon } from '../src/server.js';
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

function makeEnvelope(seq: number, text = 'hello'): Envelope {
  return {
    v: 1,
    id: `env-${seq}`,
    chat_id: 'chat-1',
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    sender: 'agent',
    body: { kind: 'text', text },
  };
}

describe('batchEnvelopes', () => {
  it('returns no batches for empty input', () => {
    assert.deepEqual(batchEnvelopes([]), []);
  });

  it('splits 250 small envelopes into [100, 100, 50] in order', () => {
    const envelopes = Array.from({ length: 250 }, (_, i) => makeEnvelope(i + 1, `msg-${i + 1}`));
    const batches = batchEnvelopes(envelopes);

    assert.deepEqual(
      batches.map((b) => b.length),
      [100, 100, 50],
    );
    assert.deepEqual(batches.flat(), envelopes);
  });

  it('splits large envelopes by byte budget so every sealed send frame fits MAX_FRAME_CHARS', () => {
    const { key } = deriveKeys(newPairingSecret());
    const envelopes = Array.from({ length: 10 }, (_, i) => makeEnvelope(i + 1, 'a'.repeat(120_000)));
    const batches = batchEnvelopes(envelopes);

    assert.ok(batches.length > 1);
    for (const batch of batches) {
      assert.ok(batch.length < 100);
      const wire = JSON.stringify({
        t: 'send',
        data: seal(key, { type: 'envelopes', envelopes: batch }),
        push: 'approval',
      });
      assert.ok(
        wire.length <= MAX_FRAME_CHARS,
        `expected wire frame length ${wire.length} <= ${MAX_FRAME_CHARS}`,
      );
    }
    assert.deepEqual(batches.flat(), envelopes);
  });

  it('emits a single oversized envelope alone', () => {
    const oversized = makeEnvelope(2, 'x'.repeat(450_000));
    assert.deepEqual(batchEnvelopes([oversized]), [[oversized]]);

    const before = makeEnvelope(1, 'small-before');
    const after = makeEnvelope(3, 'small-after');
    assert.deepEqual(batchEnvelopes([before, oversized, after]), [[before], [oversized], [after]]);
  });

  it('measures multi-byte UTF-8 text (emoji/CJK) by bytes rather than string length', () => {
    const { key } = deriveKeys(newPairingSecret());
    // 80,000 CJK chars + 20,000 emoji: .length is 120,000 UTF-16 code units, but UTF-8 is 320,000 bytes.
    // Two envelopes have combined .length ~240,000 (< SYNC_MAX_BYTES), yet ~640,000 UTF-8 bytes (> SYNC_MAX_BYTES).
    const multibyteText = '汉'.repeat(80_000) + '🚀'.repeat(20_000);
    const envelopes = [makeEnvelope(1, multibyteText), makeEnvelope(2, multibyteText)];
    const batches = batchEnvelopes(envelopes);

    assert.deepEqual(
      batches.map((b) => b.length),
      [1, 1],
    );
    assert.deepEqual(batches.flat(), envelopes);
    for (const batch of batches) {
      const wire = JSON.stringify({
        t: 'send',
        data: seal(key, { type: 'envelopes', envelopes: batch }),
        push: 'approval',
      });
      assert.ok(wire.length <= MAX_FRAME_CHARS);
    }
  });
});

function makeChat(i: number, title = `chat ${i}`): Chat {
  return {
    chat_id: `chat-${i}`,
    machine_id: 'machine-1',
    source: 'vscode',
    title,
    title_locked: false,
    status: 'running',
    last_heartbeat: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('batchChats', () => {
  const machine = { id: 'machine-1', name: 'desk' };

  it('keeps a normal chat list in one batch', () => {
    const chats = Array.from({ length: 50 }, (_, i) => makeChat(i));
    assert.deepEqual(batchChats(chats, machine), [chats]);
  });

  it('splits very large chat lists so every sealed frame fits MAX_FRAME_CHARS', () => {
    const { key } = deriveKeys(newPairingSecret());
    const chats = Array.from({ length: 400 }, (_, i) => makeChat(i, 't'.repeat(2_000)));
    const batches = batchChats(chats, machine);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flat(), chats);
    for (const batch of batches) {
      const wire = JSON.stringify({ t: 'send', data: seal(key, { type: 'chats', machine, chats: batch }) });
      assert.ok(wire.length <= MAX_FRAME_CHARS, `wire ${wire.length} > ${MAX_FRAME_CHARS}`);
    }
  });
});

describe('WindowRegistry', () => {
  it('tracks connected windows, emits change events, sends events, and replaces reconnecting ids', () => {
    const registry = new WindowRegistry();
    let changes = 0;
    registry.on('change', () => changes++);

    const events1: ExtensionEvent[] = [];
    let closed1 = false;
    const unregister1 = registry.register(
      { id: 'win-1', name: 'heyloop' },
      (ev) => events1.push(ev),
      () => {
        closed1 = true;
      },
    );
    assert.equal(changes, 1);
    assert.deepEqual(registry.list(), [{ id: 'win-1', name: 'heyloop' }]);

    const event: ExtensionEvent = { type: 'new_chat', chat_id: 'c1', chat_key: 'phone:f1', prompt: 'hi' };
    assert.equal(registry.send('win-1', event), true);
    assert.equal(registry.send('missing', event), false);
    assert.deepEqual(events1, [event]);

    // Same id reconnects -> replaces old connection and closes it; stale unregister is a no-op.
    const events2: ExtensionEvent[] = [];
    const unregister2 = registry.register({ id: 'win-1', name: 'heyloop-renamed' }, (ev) => events2.push(ev));
    assert.equal(closed1, true);
    assert.equal(changes, 2);
    unregister1();
    assert.equal(changes, 2);
    assert.deepEqual(registry.list(), [{ id: 'win-1', name: 'heyloop-renamed' }]);

    assert.equal(registry.send('win-1', event), true);
    assert.equal(events1.length, 1);
    assert.deepEqual(events2, [event]);

    unregister2();
    assert.equal(changes, 3);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.send('win-1', event), false);
  });
});

describe('RelayClient new_chat and workspaces', () => {
  it(
    'rejects offline windows with window_offline, creates chat with consumed initial text for connected window, and sends workspaces',
    withTempDir((dir) => {
      const secret = newPairingSecret();
      const { key } = deriveKeys(secret);
      const store = new Store(dir, 'machine-1');
      const broker = new ApprovalBroker(store);
      const windows = new WindowRegistry();
      const client = new RelayClient(
        { url: 'http://127.0.0.1:8787', secret },
        { id: 'machine-1', name: 'desk' },
        store,
        broker,
        windows,
      );

      // Attach a fake open WebSocket to inspect sent DaemonFrames.
      const sentFrames: DaemonFrame[] = [];
      (client as unknown as { ready: boolean; ws: { readyState: number; send: (raw: string) => void } }).ready = true;
      (client as unknown as { ready: boolean; ws: { readyState: number; send: (raw: string) => void } }).ws = {
        readyState: WebSocket.OPEN,
        send: (raw: string) => {
          const wire = JSON.parse(raw) as { t: string; data: string };
          if (wire.t === 'send') sentFrames.push(DaemonFrame.parse(open(key, wire.data)));
        },
      };

      // Offline window -> error 'window_offline' and no chat created.
      client.handle({ type: 'new_chat', id: 'frame-offline', workspace_id: 'win-1', text: 'Fix bug' });
      assert.deepEqual(store.getResult('frame-offline'), { ok: false, error: 'window_offline' });
      assert.deepEqual(store.listChats(), []);

      // Register window -> emits workspaces frame.
      const extEvents: ExtensionEvent[] = [];
      const unregister = windows.register({ id: 'win-1', name: 'heyloop' }, (ev) => extEvents.push(ev));
      assert.deepEqual(sentFrames.at(-1), { type: 'workspaces', workspaces: [{ id: 'win-1', name: 'heyloop' }] });

      // Connected window -> creates chat with chat_key, truncates title > 60 chars, appends consumed user text, emits prompt.
      const firstLine = 'A'.repeat(65);
      const fullText = `${firstLine}\nSecond line with details`;
      client.handle({ type: 'new_chat', id: 'frame-ok', workspace_id: 'win-1', text: fullText });
      assert.deepEqual(store.getResult('frame-ok'), { ok: true, error: undefined });

      const chat = store.getChatByKey('phone:frame-ok');
      assert.ok(chat);
      assert.equal(chat.source, 'vscode');
      assert.equal(chat.title, `${'A'.repeat(60)}…`);

      // Initial text is stored as a user message for the phone chat, but already marked consumed for takeInbox.
      const history = store.messagesSince(chat.chat_id, 0);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.sender, 'user');
      assert.deepEqual(history[0]?.body, { kind: 'text', text: fullText });
      assert.deepEqual(store.takeInbox(chat.chat_id), []);

      // Subsequent user say messages ARE returned by takeInbox.
      client.handle({ type: 'say', id: 'frame-say', chat_id: chat.chat_id, text: 'follow-up from phone' });
      const inbox = store.takeInbox(chat.chat_id);
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0]?.text, 'follow-up from phone');

      // Extension receives new_chat event with chat_id, chat_key, and prompt.
      assert.equal(extEvents.length, 1);
      assert.deepEqual(extEvents[0], {
        type: 'new_chat',
        chat_id: chat.chat_id,
        chat_key: 'phone:frame-ok',
        prompt: `${fullText}\n\n---\nThis task was started from the HeyLoop phone app. Use chat_key "phone:frame-ok" on every HeyLoop call for this task so your updates reach the same phone chat.`,
      });

      // sync also sends workspaces.
      sentFrames.length = 0;
      client.handle({ type: 'sync', id: 'frame-sync', cursors: {} });
      assert.deepEqual(sentFrames[0], { type: 'workspaces', workspaces: [{ id: 'win-1', name: 'heyloop' }] });

      // Phone say on a chat WITH a session id broadcasts a prompt event to every connected window;
      // without a delivery ack, the message is still returned by takeInbox.
      const extEvents2: ExtensionEvent[] = [];
      const unregister2 = windows.register({ id: 'win-2', name: 'other-ws' }, (ev) => extEvents2.push(ev));
      extEvents.length = 0;

      store.setVscodeSession(chat.chat_id, 'sess-copilot-1');
      client.handle({ type: 'say', id: 'frame-say-prompt', chat_id: chat.chat_id, text: 'run the tests next' });
      assert.deepEqual(store.getResult('frame-say-prompt'), { ok: true, error: undefined });

      assert.equal(extEvents.length, 1);
      assert.equal(extEvents2.length, 1);
      assert.equal(extEvents[0]?.type, 'prompt');
      assert.deepEqual(extEvents[0], extEvents2[0]);
      if (extEvents[0]?.type === 'prompt') {
        assert.equal(extEvents[0].chat_id, chat.chat_id);
        assert.equal(extEvents[0].session_id, 'sess-copilot-1');
        assert.equal(extEvents[0].text, 'run the tests next');
      }

      // Without a delivery ack, takeInbox still returns the message.
      const unackedInbox = store.takeInbox(chat.chat_id);
      assert.equal(unackedInbox.length, 1);
      assert.equal(unackedInbox[0]?.text, 'run the tests next');
      if (extEvents[0]?.type === 'prompt') {
        assert.equal(unackedInbox[0]?.id, extEvents[0].message_id);
      }

      // Phone say on a chat WITHOUT a session id emits nothing to connected windows and behaves as before.
      const chatNoSession = store.createChat('vscode', 'No session chat');
      extEvents.length = 0;
      extEvents2.length = 0;
      client.handle({ type: 'say', id: 'frame-say-nosess', chat_id: chatNoSession.chat_id, text: 'plain inbox msg' });
      assert.deepEqual(store.getResult('frame-say-nosess'), { ok: true, error: undefined });
      assert.deepEqual(extEvents, []);
      assert.deepEqual(extEvents2, []);
      const plainInbox = store.takeInbox(chatNoSession.chat_id);
      assert.equal(plainInbox.length, 1);
      assert.equal(plainInbox[0]?.text, 'plain inbox msg');

      unregister2();
      unregister();
      assert.deepEqual(sentFrames.at(-1), { type: 'workspaces', workspaces: [] });
    }),
  );
});

describe('GET /api/windows/events SSE route and POST /api/windows/delivered', () => {
  it(
    'validates auth and Workspace schema, streams ExtensionEvents over SSE, unregisters on close, and handles delivered acks idempotently',
    withTempDir(async (dir) => {
      const prevHome = process.env.HEYLOOP_HOME;
      process.env.HEYLOOP_HOME = dir;
      const windows = new WindowRegistry();
      const server = startDaemon(
        { port: 0, token: 'test-secret-token', machine_id: 'm1', machine_name: 'desk' },
        windows,
      );
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const { port } = server.address() as AddressInfo;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));

        const srv = startDaemon(
          { port, token: 'test-secret-token', machine_id: 'm1', machine_name: 'desk' },
          windows,
        );
        try {
          await new Promise<void>((resolve) => srv.once('listening', resolve));
          const base = `http://127.0.0.1:${port}`;
          const headers = { Authorization: 'Bearer test-secret-token' };
          const jsonHeaders = { ...headers, 'content-type': 'application/json' };

          const unauth = await fetch(`${base}/api/windows/events?id=w1&name=proj`);
          assert.equal(unauth.status, 403);

          const badParams = await fetch(`${base}/api/windows/events?id=&name=proj`, { headers });
          assert.equal(badParams.status, 400);

          const ac = new AbortController();
          const res = await fetch(`${base}/api/windows/events?id=w1&name=proj`, { headers, signal: ac.signal });
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('content-type'), 'text/event-stream');
          assert.deepEqual(windows.list(), [{ id: 'w1', name: 'proj' }]);

          const sent = windows.send('w1', {
            type: 'new_chat',
            chat_id: 'c1',
            chat_key: 'phone:1',
            prompt: 'hello world',
          });
          assert.equal(sent, true);

          const reader = res.body!.getReader();
          const { value } = await reader.read();
          const chunk = new TextDecoder().decode(value);
          assert.equal(
            chunk,
            `data: ${JSON.stringify({ type: 'new_chat', chat_id: 'c1', chat_key: 'phone:1', prompt: 'hello world' })}\n\n`,
          );

          ac.abort();
          for (let i = 0; i < 20 && windows.list().length > 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.deepEqual(windows.list(), []);

          // POST /api/windows/delivered: auth, schema validation, 404 unknown, marks consumed, idempotent repeat.
          const unauthDelivered = await fetch(`${base}/api/windows/delivered`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message_id: 'm1', window_id: 'w1' }),
          });
          assert.equal(unauthDelivered.status, 403);

          const badDelivered = await fetch(`${base}/api/windows/delivered`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ message_id: '', window_id: 'w1' }),
          });
          assert.equal(badDelivered.status, 400);

          const missingDelivered = await fetch(`${base}/api/windows/delivered`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ message_id: 'unknown-msg-id', window_id: 'w1' }),
          });
          assert.equal(missingDelivered.status, 404);

          const store = new Store(dir, 'm1');
          const chat = store.createChat('vscode', 'Delivered test');
          const msg1 = store.append(chat.chat_id, 'user', { kind: 'text', text: 'delivered to window' });
          const msg2 = store.append(chat.chat_id, 'user', { kind: 'text', text: 'not acked by window' });

          const ack1 = await fetch(`${base}/api/windows/delivered`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ message_id: msg1.id, window_id: 'w1' }),
          });
          assert.equal(ack1.status, 200);
          assert.deepEqual(await ack1.json(), { ok: true });

          // Repeated ack for the same message_id returns 200 {ok:true} idempotently.
          const ackRepeat = await fetch(`${base}/api/windows/delivered`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ message_id: msg1.id, window_id: 'w1' }),
          });
          assert.equal(ackRepeat.status, 200);
          assert.deepEqual(await ackRepeat.json(), { ok: true });

          // takeInbox no longer returns the delivered message, but still returns the unacked message.
          const remainingInbox = store.takeInbox(chat.chat_id);
          assert.equal(remainingInbox.length, 1);
          assert.equal(remainingInbox[0]?.id, msg2.id);
          assert.equal(remainingInbox[0]?.text, 'not acked by window');
        } finally {
          srv.closeAllConnections();
          await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
      } finally {
        if (prevHome === undefined) delete process.env.HEYLOOP_HOME;
        else process.env.HEYLOOP_HOME = prevHome;
      }
    }),
  );
});

