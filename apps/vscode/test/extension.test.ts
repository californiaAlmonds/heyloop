import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { configPath, dataDir, loadConfig } from '../src/config.js';
import { SseParser } from '../src/sse.js';

describe('SseParser', () => {
  it('parses complete single-line data events', () => {
    const received: string[] = [];
    const parser = new SseParser((d) => received.push(d));

    const out = parser.feed('data: {"type":"new_chat","chat_id":"c1","chat_key":"k1","prompt":"hi"}\n\n');
    assert.deepEqual(out, ['{"type":"new_chat","chat_id":"c1","chat_key":"k1","prompt":"hi"}']);
    assert.deepEqual(received, out);
  });

  it('reassembles events split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed('da'), []);
    assert.deepEqual(parser.feed('ta: hel'), []);
    assert.deepEqual(parser.feed('lo world\n'), []);
    assert.deepEqual(parser.feed('\nda'), ['hello world']);
    assert.deepEqual(parser.feed('ta: second\r'), []);
    assert.deepEqual(parser.feed('\n\r'), []);
    assert.deepEqual(parser.feed('\n'), ['second']);
  });

  it('ignores comment lines starting with colon and blank heartbeats', () => {
    const parser = new SseParser();
    const out = parser.feed(': keepalive\n\n: another comment\ndata: payload\n: mid-event comment\n\n\n');
    assert.deepEqual(out, ['payload']);
  });

  it('joins multi-line data fields with newline', () => {
    const parser = new SseParser();
    const out = parser.feed('event: message\ndata: line 1\ndata: line 2\ndata:   indented 3\ndata\n\n');
    assert.deepEqual(out, ['line 1\nline 2\n  indented 3\n']);
  });

  it('clears buffered partial state on reset', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed('data: partial\n'), []);
    parser.reset();
    assert.deepEqual(parser.feed('data: fresh\n\n'), ['fresh']);
  });
});

describe('config loading', () => {
  it('loads port and token from HEYLOOP_HOME/config.json and handles token rotation', () => {
    const prevHome = process.env.HEYLOOP_HOME;
    const tempDir = mkdtempSync(join(import.meta.dirname, '.tmp-heyloop-home-'));
    try {
      process.env.HEYLOOP_HOME = tempDir;
      assert.equal(dataDir(), tempDir);
      assert.equal(configPath(), join(tempDir, 'config.json'));

      writeFileSync(
        join(tempDir, 'config.json'),
        JSON.stringify({ port: 4519, token: 'tok-initial', machine_id: 'm1', machine_name: 'box' }),
      );
      assert.deepEqual(loadConfig(), { port: 4519, token: 'tok-initial' });

      writeFileSync(
        join(tempDir, 'config.json'),
        JSON.stringify({ port: 4600, token: 'tok-rotated' }),
      );
      assert.deepEqual(loadConfig(), { port: 4600, token: 'tok-rotated' });
    } finally {
      if (prevHome === undefined) {
        delete process.env.HEYLOOP_HOME;
      } else {
        process.env.HEYLOOP_HOME = prevHome;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
    assert.equal(existsSync(tempDir), false);
  });

  it('falls back to ~/.heyloop when HEYLOOP_HOME is unset and validates fields', () => {
    const prevHome = process.env.HEYLOOP_HOME;
    const tempDir = mkdtempSync(join(import.meta.dirname, '.tmp-heyloop-invalid-'));
    try {
      delete process.env.HEYLOOP_HOME;
      assert.equal(dataDir(), join(homedir(), '.heyloop'));

      process.env.HEYLOOP_HOME = tempDir;
      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ port: 70000, token: 'secret-tok' }));
      assert.throws(() => loadConfig(), /port/);

      writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ port: 4519, token: '' }));
      assert.throws(() => loadConfig(), /token/);
    } finally {
      if (prevHome === undefined) {
        delete process.env.HEYLOOP_HOME;
      } else {
        process.env.HEYLOOP_HOME = prevHome;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
    assert.equal(existsSync(tempDir), false);
  });
});
