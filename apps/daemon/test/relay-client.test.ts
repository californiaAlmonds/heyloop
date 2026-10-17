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
  it(
    'tracks connected windows and stable workspaces, persists across Store reopen, and only emits change when workspace open state changes',
    withTempDir((dir) => {
      const store = new Store(dir, 'm1');
      const registry = new WindowRegistry(store);
      let changes = 0;
      registry.on('change', () => changes++);

      const events1: ExtensionEvent[] = [];
      let closed1 = false;
      const unregister1 = registry.register(
        { id: 'win-1', name: 'heyloop', workspace: 'aaaa1111', folder: 'E:\\heyloop' },
        (ev) => events1.push(ev),
        () => {
          closed1 = true;
        },
      );
      assert.equal(changes, 1);
      assert.deepEqual(registry.workspaces(), [{ id: 'aaaa1111', name: 'heyloop', open: true }]);
      assert.deepEqual(registry.openWorkspaceIds(), new Set(['aaaa1111']));
      assert.equal(registry.workspaceForWindow('win-1'), 'aaaa1111');
      assert.equal(registry.windowForWorkspace('aaaa1111')?.id, 'win-1');
      assert.equal(store.getWorkspace('aaaa1111')?.folder, 'E:\\heyloop');

      const event: ExtensionEvent = { type: 'new_chat', chat_id: 'c1', chat_key: 'phone:f1', prompt: 'hi' };
      assert.equal(registry.send('win-1', event), true);
      assert.equal(registry.send('missing', event), false);
      assert.deepEqual(events1, [event]);

      // A second window of the SAME workspace connecting does NOT flip state or emit change.
      const eventsSecond: ExtensionEvent[] = [];
      const unregisterSecond = registry.register(
        { id: 'win-2', name: 'heyloop', workspace: 'aaaa1111', folder: 'E:\\heyloop' },
        (ev) => eventsSecond.push(ev),
      );
      assert.equal(changes, 1);
      assert.equal(registry.size, 2);
      assert.deepEqual(registry.workspaces(), [{ id: 'aaaa1111', name: 'heyloop', open: true }]);

      // sendToWorkspace sends only to windows of that workspace.
      const wsEvent: ExtensionEvent = { type: 'whose_session', session_id: 'sess-ws' };
      registry.sendToWorkspace('bbbb2222', wsEvent);
      assert.equal(events1.length, 1);
      assert.deepEqual(eventsSecond, []);
      registry.sendToWorkspace('aaaa1111', wsEvent);
      assert.equal(events1.at(-1), wsEvent);
      assert.deepEqual(eventsSecond, [wsEvent]);

      // Closing one of the two windows for the same workspace keeps the workspace open and does NOT emit change.
      unregisterSecond();
      assert.equal(changes, 1);
      assert.equal(registry.size, 1);
      assert.deepEqual(registry.workspaces(), [{ id: 'aaaa1111', name: 'heyloop', open: true }]);
      assert.equal(registry.windowForWorkspace('aaaa1111')?.id, 'win-1');

      // Same window id reconnects with updated name -> replaces old connection and closes it; stale unregister is a no-op.
      const events2: ExtensionEvent[] = [];
      let allowWrite = true;
      const unregister2 = registry.register(
        { id: 'win-1', name: 'heyloop-renamed', workspace: 'aaaa1111' },
        (ev) => {
          events2.push(ev);
          return allowWrite;
        },
      );
      assert.equal(closed1, true);
      assert.equal(changes, 2);
      unregister1();
      assert.equal(changes, 2);
      assert.deepEqual(registry.workspaces(), [{ id: 'aaaa1111', name: 'heyloop-renamed', open: true }]);

      assert.equal(registry.send('win-1', event), true);
      assert.equal(events1.length, 2);
      assert.deepEqual(events2, [event]);

      // When write returns false (backpressure), send returns false.
      allowWrite = false;
      assert.equal(registry.send('win-1', event), false);

      // Disconnecting the last window of the workspace flips open to false and emits change.
      unregister2();
      assert.equal(changes, 3);
      assert.equal(registry.size, 0);
      assert.deepEqual(registry.workspaces(), [{ id: 'aaaa1111', name: 'heyloop-renamed', open: false }]);
      assert.equal(registry.windowForWorkspace('aaaa1111'), undefined);
      assert.equal(registry.send('win-1', event), false);

      // Reopening Store preserves the workspace with open=false.
      const store2 = new Store(dir, 'm1');
      const registry2 = new WindowRegistry(store2);
      assert.deepEqual(registry2.workspaces(), [{ id: 'aaaa1111', name: 'heyloop-renamed', open: false }]);
    }),
  );
});

describe('RelayClient new_chat and workspaces', () => {
  it(
    'rejects offline workspaces with window_offline, routes new_chat by stable workspace id to a connected window, sets chat.workspace_id, and sends workspaces with open flags',
    withTempDir((dir) => {
      const secret = newPairingSecret();
      const { key } = deriveKeys(secret);
      const store = new Store(dir, 'machine-1');
      const broker = new ApprovalBroker(store);
      const windows = new WindowRegistry(store);
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

      // Offline workspace -> error 'window_offline' and no chat created.
      client.handle({ type: 'new_chat', id: 'frame-offline', workspace_id: 'aaaa1111', text: 'Fix bug' });
      assert.deepEqual(store.getResult('frame-offline'), { ok: false, error: 'window_offline' });
      assert.deepEqual(store.listChats(), []);

      // Register window -> emits workspaces frame with open=true (keyed by stable workspace id).
      const extEvents: ExtensionEvent[] = [];
      const unregister = windows.register(
        { id: 'win-1', name: 'heyloop', workspace: 'aaaa1111', folder: 'E:\\heyloop' },
        (ev) => extEvents.push(ev),
      );
      assert.deepEqual(sentFrames.at(-1), {
        type: 'workspaces',
        workspaces: [{ id: 'aaaa1111', name: 'heyloop', open: true }],
      });

      // Connected workspace -> creates chat with workspace_id and chat_key, truncates title > 60 chars, appends consumed user text, emits prompt.
      const firstLine = 'A'.repeat(65);
      const fullText = `${firstLine}\nSecond line with details`;
      sentFrames.length = 0;
      client.handle({ type: 'new_chat', id: 'frame-ok', workspace_id: 'aaaa1111', text: fullText });
      assert.deepEqual(store.getResult('frame-ok'), { ok: true, error: undefined });

      const chat = store.getChatByKey('phone:frame-ok');
      assert.ok(chat);
      assert.equal(chat.source, 'vscode');
      assert.equal(chat.title, `${'A'.repeat(60)}…`);
      assert.equal(chat.workspace_id, 'aaaa1111');

      // Chat object sent to phone in 'chats' DaemonFrame includes workspace_id.
      const chatFrame = sentFrames.find((f) => f.type === 'chats');
      assert.ok(chatFrame && chatFrame.type === 'chats');
      assert.equal(chatFrame.chats[0]?.workspace_id, 'aaaa1111');

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

      // sync also sends workspaces with open flags and chats with workspace_id.
      sentFrames.length = 0;
      client.handle({ type: 'sync', id: 'frame-sync', cursors: {} });
      assert.deepEqual(sentFrames[0], {
        type: 'workspaces',
        workspaces: [{ id: 'aaaa1111', name: 'heyloop', open: true }],
      });
      const syncedChats = sentFrames.find((f) => f.type === 'chats');
      assert.ok(syncedChats && syncedChats.type === 'chats');
      assert.equal(syncedChats.chats[0]?.workspace_id, 'aaaa1111');

      // Phone say on a chat WITH a session id and a known workspace_id sends a prompt event ONLY to windows of that workspace;
      // without a delivery ack, the message is still returned by takeInbox.
      const extEventsSameWs: ExtensionEvent[] = [];
      const unregisterSameWs = windows.register(
        { id: 'win-1b', name: 'heyloop', workspace: 'aaaa1111' },
        (ev) => extEventsSameWs.push(ev),
      );
      const extEvents2: ExtensionEvent[] = [];
      const unregister2 = windows.register(
        { id: 'win-2', name: 'other-ws', workspace: 'bbbb2222' },
        (ev) => extEvents2.push(ev),
      );
      extEvents.length = 0;

      store.setVscodeSession(chat.chat_id, 'sess-copilot-1');
      client.handle({ type: 'say', id: 'frame-say-prompt', chat_id: chat.chat_id, text: 'run the tests next' });
      assert.deepEqual(store.getResult('frame-say-prompt'), { ok: true, error: undefined });

      assert.equal(extEvents.length, 1);
      assert.equal(extEventsSameWs.length, 1);
      assert.equal(extEvents2.length, 0);
      assert.equal(extEvents[0]?.type, 'prompt');
      assert.deepEqual(extEvents[0], extEventsSameWs[0]);
      if (extEvents[0]?.type === 'prompt') {
        assert.equal(extEvents[0].chat_id, chat.chat_id);
        assert.equal(extEvents[0].session_id, 'sess-copilot-1');
        assert.equal(extEvents[0].text, 'run the tests next');
      }
      unregisterSameWs();

      // Without a delivery ack, takeInbox still returns the message.
      const unackedInbox = store.takeInbox(chat.chat_id);
      assert.equal(unackedInbox.length, 1);
      assert.equal(unackedInbox[0]?.text, 'run the tests next');
      if (extEvents[0]?.type === 'prompt') {
        assert.equal(unackedInbox[0]?.id, extEvents[0].message_id);
      }

      // Phone say on a chat WITH a session id but NO workspace_id yet broadcasts the prompt event to all connected windows.
      const unclaimedWithSession = store.createChat('vscode', 'Unclaimed session chat');
      store.setVscodeSession(unclaimedWithSession.chat_id, 'sess-unclaimed-bcast');
      extEvents.length = 0;
      extEvents2.length = 0;
      client.handle({
        type: 'say',
        id: 'frame-say-bcast',
        chat_id: unclaimedWithSession.chat_id,
        text: 'broadcast while workspace unknown',
      });
      assert.deepEqual(store.getResult('frame-say-bcast'), { ok: true, error: undefined });
      assert.equal(extEvents.length, 1);
      assert.equal(extEvents2.length, 1);
      assert.deepEqual(extEvents[0], extEvents2[0]);
      if (extEvents[0]?.type === 'prompt') {
        assert.equal(extEvents[0].chat_id, unclaimedWithSession.chat_id);
        assert.equal(extEvents[0].session_id, 'sess-unclaimed-bcast');
        assert.equal(extEvents[0].text, 'broadcast while workspace unknown');
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

      // Disconnecting windows keeps known workspaces in the frame with open=false, and new_chat to closed workspace returns window_offline.
      unregister2();
      unregister();
      const lastWsFrame = sentFrames.at(-1);
      assert.ok(lastWsFrame && lastWsFrame.type === 'workspaces');
      assert.deepEqual(
        new Map(lastWsFrame.workspaces.map((w) => [w.id, w])),
        new Map([
          ['aaaa1111', { id: 'aaaa1111', name: 'heyloop', open: false }],
          ['bbbb2222', { id: 'bbbb2222', name: 'other-ws', open: false }],
        ]),
      );

      client.handle({ type: 'new_chat', id: 'frame-closed-ws', workspace_id: 'aaaa1111', text: 'Closed now' });
      assert.deepEqual(store.getResult('frame-closed-ws'), { ok: false, error: 'window_offline' });
    }),
  );
});

function createSseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return async (): Promise<ExtensionEvent> => {
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) return ExtensionEvent.parse(JSON.parse(line.slice(6)));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before event');
      buf += decoder.decode(value, { stream: true });
    }
  };
}

describe('GET /api/windows/events SSE route, POST /api/windows/claim, and POST /api/windows/delivered', () => {
  it(
    'validates WindowHello, deduplicates replay across workspace windows, replays on claim, enforces 32-window and 200-message caps, and handles delivered acks',
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

          const unauth = await fetch(`${base}/api/windows/events?id=w1&name=proj&workspace=abcd1234`);
          assert.equal(unauth.status, 403);

          // Old SSE clients that omit `workspace` get a 400.
          const missingWorkspace = await fetch(`${base}/api/windows/events?id=w1&name=proj`, { headers });
          assert.equal(missingWorkspace.status, 400);

          const badParams = await fetch(`${base}/api/windows/events?id=&name=proj&workspace=abcd1234`, { headers });
          assert.equal(badParams.status, 400);

          const badWorkspace = await fetch(`${base}/api/windows/events?id=w1&name=proj&workspace=NOT_HEX`, { headers });
          assert.equal(badWorkspace.status, 400);

          const ac = new AbortController();
          const res = await fetch(
            `${base}/api/windows/events?id=w1&name=proj&workspace=abcd1234&folder=${encodeURIComponent('/repo/proj')}`,
            { headers, signal: ac.signal },
          );
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('content-type'), 'text/event-stream');
          assert.deepEqual(windows.workspaces(), [{ id: 'abcd1234', name: 'proj', open: true }]);

          const nextEvent1 = createSseReader(res);
          const sent = windows.send('w1', {
            type: 'new_chat',
            chat_id: 'c1',
            chat_key: 'phone:1',
            prompt: 'hello world',
          });
          assert.equal(sent, true);
          assert.deepEqual(await nextEvent1(), {
            type: 'new_chat',
            chat_id: 'c1',
            chat_key: 'phone:1',
            prompt: 'hello world',
          });

          // POST /api/windows/claim: 404 for unknown window, sets workspace_id on chats with session, replays unconsumed user text in seq order to claiming window.
          const unknownWinClaim = await fetch(`${base}/api/windows/claim`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ window_id: 'unknown-win', session_id: 'sess-claim-1' }),
          });
          assert.equal(unknownWinClaim.status, 404);

          const store = new Store(dir, 'm1');
          const unclaimedChat = store.createChat('vscode', 'Unclaimed chat');
          store.setVscodeSession(unclaimedChat.chat_id, 'sess-claim-1');
          assert.equal(store.getChat(unclaimedChat.chat_id)?.workspace_id, undefined);
          store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'already consumed before claim' }, true);
          const claimMsg1 = store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'claim replay 1' });
          const claimMsg2 = store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'claim replay 2' });

          const claim1 = await fetch(`${base}/api/windows/claim`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ window_id: 'w1', session_id: 'sess-claim-1' }),
          });
          assert.equal(claim1.status, 200);
          assert.deepEqual(await claim1.json(), { ok: true });
          assert.equal(store.getChat(unclaimedChat.chat_id)?.workspace_id, 'abcd1234');
          assert.deepEqual(await nextEvent1(), {
            type: 'prompt',
            message_id: claimMsg1.id,
            chat_id: unclaimedChat.chat_id,
            session_id: 'sess-claim-1',
            text: 'claim replay 1',
          });
          assert.deepEqual(await nextEvent1(), {
            type: 'prompt',
            message_id: claimMsg2.id,
            chat_id: unclaimedChat.chat_id,
            session_id: 'sess-claim-1',
            text: 'claim replay 2',
          });
          store.markConsumed(claimMsg1.id);
          store.markConsumed(claimMsg2.id);

          // Idempotent repeat claim by same window -> 200 {ok:true} and no duplicate replay.
          const claimRepeat = await fetch(`${base}/api/windows/claim`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ window_id: 'w1', session_id: 'sess-claim-1' }),
          });
          assert.equal(claimRepeat.status, 200);
          assert.deepEqual(await claimRepeat.json(), { ok: true });

          // Another window from a different workspace claiming the same session does NOT overwrite workspace_id.
          const acOther = new AbortController();
          const resOther = await fetch(
            `${base}/api/windows/events?id=w2&name=other&workspace=ef012345`,
            { headers, signal: acOther.signal },
          );
          assert.equal(resOther.status, 200);
          const claimOther = await fetch(`${base}/api/windows/claim`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ window_id: 'w2', session_id: 'sess-claim-1' }),
          });
          assert.equal(claimOther.status, 200);
          assert.equal(store.getChat(unclaimedChat.chat_id)?.workspace_id, 'abcd1234');
          acOther.abort();

          // Disconnect w1 so workspace 'abcd1234' is closed.
          ac.abort();
          for (let i = 0; i < 20 && windows.list().length > 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }
          assert.deepEqual(
            new Map(windows.workspaces().map((w) => [w.id, w.open])),
            new Map([
              ['abcd1234', false],
              ['ef012345', false],
            ]),
          );

          // While workspace 'abcd1234' is closed: queue user messages on unclaimedChat (which belongs to 'abcd1234' and has 'sess-claim-1').
          store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'already consumed' }, true);
          const qMsg1 = store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'queued first' });
          const qMsg2 = store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: 'queued second' });

          // Also create a chat with a session id but no workspace_id yet -> should emit whose_session on connect.
          const mysteryChat = store.createChat('vscode', 'Mystery session chat');
          store.setVscodeSession(mysteryChat.chat_id, 'sess-mystery-99');

          // Reconnect a window for workspace 'abcd1234' (first connected window of its workspace):
          // it should receive the two queued prompts in seq order and whose_session.
          const ac2 = new AbortController();
          const res2 = await fetch(
            `${base}/api/windows/events?id=w1-reconnected&name=proj&workspace=abcd1234`,
            { headers, signal: ac2.signal },
          );
          assert.equal(res2.status, 200);
          const nextEvent2 = createSseReader(res2);

          const ev1 = await nextEvent2();
          const ev2 = await nextEvent2();
          const ev3 = await nextEvent2();
          assert.deepEqual(ev1, {
            type: 'prompt',
            message_id: qMsg1.id,
            chat_id: unclaimedChat.chat_id,
            session_id: 'sess-claim-1',
            text: 'queued first',
          });
          assert.deepEqual(ev2, {
            type: 'prompt',
            message_id: qMsg2.id,
            chat_id: unclaimedChat.chat_id,
            session_id: 'sess-claim-1',
            text: 'queued second',
          });
          assert.deepEqual(ev3, {
            type: 'whose_session',
            session_id: 'sess-mystery-99',
          });

          // A second window of the SAME already-open workspace ('abcd1234') gets NO replay (no queued prompts, no whose_session).
          const acSecond = new AbortController();
          const resSecond = await fetch(
            `${base}/api/windows/events?id=w1-second&name=proj&workspace=abcd1234`,
            { headers, signal: acSecond.signal },
          );
          assert.equal(resSecond.status, 200);
          const nextEventSecond = createSseReader(resSecond);
          windows.send('w1-second', {
            type: 'new_chat',
            chat_id: 'c-sentinel',
            chat_key: 'phone:sentinel',
            prompt: 'live event only',
          });
          // If w1-second had received any replayed prompt or whose_session, it would arrive before 'c-sentinel'.
          assert.deepEqual(await nextEventSecond(), {
            type: 'new_chat',
            chat_id: 'c-sentinel',
            chat_key: 'phone:sentinel',
            prompt: 'live event only',
          });

          // Reconnecting with the SAME window id ('w1-reconnected') replaces the previous connection and DOES get replay.
          const acReplace = new AbortController();
          const resReplace = await fetch(
            `${base}/api/windows/events?id=w1-reconnected&name=proj&workspace=abcd1234`,
            { headers, signal: acReplace.signal },
          );
          assert.equal(resReplace.status, 200);
          const nextEventReplace = createSseReader(resReplace);
          assert.deepEqual(await nextEventReplace(), {
            type: 'prompt',
            message_id: qMsg1.id,
            chat_id: unclaimedChat.chat_id,
            session_id: 'sess-claim-1',
            text: 'queued first',
          });
          acReplace.abort();
          acSecond.abort();
          ac2.abort();
          for (let i = 0; i < 20 && windows.size > 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }

          // Mark mysteryChat claimed and qMsg1/qMsg2 consumed before testing the 200-message replay cap.
          store.setChatWorkspace(mysteryChat.chat_id, 'ef012345');
          store.markConsumed(qMsg1.id);
          store.markConsumed(qMsg2.id);

          // Replay cap: queue 250 messages while workspace 'abcd1234' is closed; connect replays oldest 200 in order, leaving 50 for inbox / next connect.
          const cappedMsgs = Array.from({ length: 250 }, (_, i) =>
            store.append(unclaimedChat.chat_id, 'user', { kind: 'text', text: `capped-${i + 1}` }),
          );
          const acCap = new AbortController();
          const resCap = await fetch(
            `${base}/api/windows/events?id=w-cap&name=proj&workspace=abcd1234`,
            { headers, signal: acCap.signal },
          );
          assert.equal(resCap.status, 200);
          const nextCapEvent = createSseReader(resCap);
          for (let i = 0; i < 200; i++) {
            const ev = await nextCapEvent();
            assert.deepEqual(ev, {
              type: 'prompt',
              message_id: cappedMsgs[i]!.id,
              chat_id: unclaimedChat.chat_id,
              session_id: 'sess-claim-1',
              text: `capped-${i + 1}`,
            });
            store.markConsumed(cappedMsgs[i]!.id);
          }
          // Send a sentinel event right after connect; it must arrive next (proving messages 201..250 were not replayed).
          windows.send('w-cap', {
            type: 'new_chat',
            chat_id: 'c-after-200',
            chat_key: 'phone:after-200',
            prompt: 'after 200 cap',
          });
          assert.deepEqual(await nextCapEvent(), {
            type: 'new_chat',
            chat_id: 'c-after-200',
            chat_key: 'phone:after-200',
            prompt: 'after 200 cap',
          });
          // The remaining 50 messages stay queued for the agent inbox / next connect.
          assert.equal(store.peekInbox(unclaimedChat.chat_id).length, 50);
          assert.equal(store.peekInbox(unclaimedChat.chat_id)[0]?.text, 'capped-201');
          assert.equal(store.peekInbox(unclaimedChat.chat_id)[49]?.text, 'capped-250');
          store.takeInbox(unclaimedChat.chat_id);
          acCap.abort();
          for (let i = 0; i < 20 && windows.size > 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }

          // Connection cap: 32 concurrently connected windows allowed; 33rd new window gets 429 before registering.
          const capControllers: AbortController[] = [];
          for (let i = 0; i < 32; i++) {
            const c = new AbortController();
            capControllers.push(c);
            const wsHex = (0x10000000 + i).toString(16);
            const r = await fetch(`${base}/api/windows/events?id=win-cap-${i}&name=ws-${i}&workspace=${wsHex}`, {
              headers,
              signal: c.signal,
            });
            assert.equal(r.status, 200);
          }
          assert.equal(windows.size, 32);

          const overCap = await fetch(`${base}/api/windows/events?id=win-cap-32&name=ws-32&workspace=99999999`, {
            headers,
          });
          assert.equal(overCap.status, 429);
          assert.equal(windows.size, 32);
          assert.equal(windows.has('win-cap-32'), false);

          for (const c of capControllers) c.abort();
          for (let i = 0; i < 20 && windows.size > 0; i++) {
            await new Promise((r) => setTimeout(r, 20));
          }

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

