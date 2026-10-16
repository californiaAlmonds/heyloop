import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Chat, Envelope } from '@heyloop/protocol';
import { deriveKeys, newPairingSecret, seal } from '@heyloop/protocol/crypto';
import { MAX_FRAME_CHARS } from '@heyloop/protocol/relay';
import { batchChats, batchEnvelopes } from '../src/relay-client.js';

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
