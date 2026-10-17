import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PromptDelivered, SessionClaim } from '@heyloop/protocol';
import { configPath, dataDir, loadConfig } from '../src/config.js';
import {
  buildClaimRequest,
  buildDeliveredRequest,
  createPromptQueue,
  ownsSession,
  postPromptDelivered,
  postSessionClaim,
  sessionUri,
  sessionUriString,
} from '../src/session.js';
import { SseParser } from '../src/sse.js';
import { eventsUrl, workspaceKey } from '../src/workspace.js';

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

describe('session helpers', () => {
  it('encodes sessionUri / sessionUriString as vscode-chat-session://local/<base64url>', () => {
    const id = 'dc621762-e451-4fab-ab81-c6be84cb738e';
    const expected = 'vscode-chat-session://local/ZGM2MjE3NjItZTQ1MS00ZmFiLWFiODEtYzZiZTg0Y2I3Mzhl';
    assert.equal(sessionUri(id), expected);
    assert.equal(sessionUriString(id), expected);

    // Ensure base64url without padding (`=`) and using `-` / `_`
    const urlUnsafeUtf8 = 'session?>>id';
    const uri = sessionUri(urlUnsafeUtf8);
    assert.ok(uri.startsWith('vscode-chat-session://local/'));
    const pathPart = uri.slice('vscode-chat-session://local/'.length);
    assert.equal(pathPart.includes('='), false);
    assert.equal(pathPart.includes('+'), false);
    assert.equal(pathPart.includes('/'), false);
    assert.equal(Buffer.from(pathPart, 'base64url').toString('utf8'), urlUnsafeUtf8);
  });

  it('ownsSession checks chatSessions/<id>.jsonl or .json and rejects missing dirs or traversal ids', () => {
    const tempDir = mkdtempSync(join(import.meta.dirname, '.tmp-heyloop-storage-'));
    try {
      // Missing storageDir or missing chatSessions directory
      assert.equal(ownsSession(undefined, 's1'), false);
      assert.equal(ownsSession('', 's1'), false);
      assert.equal(ownsSession(tempDir, 's1'), false);
      assert.equal(ownsSession(join(tempDir, 'nonexistent'), 's1'), false);

      const chatSessionsDir = join(tempDir, 'chatSessions');
      mkdirSync(chatSessionsDir, { recursive: true });
      writeFileSync(join(chatSessionsDir, 'sess-jsonl.jsonl'), '{}\n');
      writeFileSync(join(chatSessionsDir, 'sess-json.json'), '{}');
      writeFileSync(join(tempDir, 'outside.jsonl'), '{}\n');

      assert.equal(ownsSession(tempDir, 'sess-jsonl'), true);
      assert.equal(ownsSession(tempDir, 'sess-json'), true);
      assert.equal(ownsSession(tempDir, 'missing-sess'), false);
      assert.equal(ownsSession(tempDir, ''), false);

      // Reject path separators and .. even when target files exist
      assert.equal(ownsSession(tempDir, '../outside'), false);
      assert.equal(ownsSession(tempDir, '..\\outside'), false);
      assert.equal(ownsSession(tempDir, 'sub/sess-jsonl'), false);
      assert.equal(ownsSession(tempDir, 'sub\\sess-jsonl'), false);
      assert.equal(ownsSession(tempDir, 'sess..bad'), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds and posts the PromptDelivered ack request with the expected shape', async () => {
    const config = { port: 4519, token: 'test-token-123' };
    const payload = { message_id: 'msg-42', window_id: 'win-abc' };

    const req = buildDeliveredRequest(config, payload);
    assert.equal(req.url, 'http://127.0.0.1:4519/api/windows/delivered');
    assert.equal(req.init.method, 'POST');
    assert.deepEqual(req.init.headers, {
      Authorization: 'Bearer test-token-123',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(PromptDelivered.parse(JSON.parse(req.init.body)), payload);

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await postPromptDelivered(config, payload, (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'http://127.0.0.1:4519/api/windows/delivered');
    assert.equal(call.init?.method, 'POST');
    assert.deepEqual(call.init?.headers, {
      Authorization: 'Bearer test-token-123',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(JSON.parse(String(call.init?.body)), payload);

    await assert.rejects(
      () =>
        postPromptDelivered(config, payload, (async () => new Response('fail', { status: 500 })) as typeof fetch),
      /HTTP 500/,
    );
  });

  it('serializes prompt tasks sequentially in order and recovers after errors', async () => {
    const enqueue = createPromptQueue();
    const order: string[] = [];

    const p1 = enqueue(async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end-1');
    });
    const p2 = enqueue(async () => {
      order.push('start-2');
      throw new Error('boom');
    }).catch(() => {
      order.push('caught-2');
    });
    const p3 = enqueue(async () => {
      order.push('start-3');
      order.push('end-3');
    });

    await Promise.all([p1, p2, p3]);
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'caught-2', 'start-3', 'end-3']);
  });

  it('builds and posts the SessionClaim request to /api/windows/claim with bearer token', async () => {
    const config = { port: 4519, token: 'claim-token-456' };
    const payload = { window_id: 'win-xyz', session_id: 'sess-789' };

    const req = buildClaimRequest(config, payload);
    assert.equal(req.url, 'http://127.0.0.1:4519/api/windows/claim');
    assert.equal(req.init.method, 'POST');
    assert.deepEqual(req.init.headers, {
      Authorization: 'Bearer claim-token-456',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(SessionClaim.parse(JSON.parse(req.init.body)), payload);

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    await postSessionClaim(config, payload, (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, 'http://127.0.0.1:4519/api/windows/claim');
    assert.equal(call.init?.method, 'POST');
    assert.deepEqual(call.init?.headers, {
      Authorization: 'Bearer claim-token-456',
      'Content-Type': 'application/json',
    });
    assert.deepEqual(JSON.parse(String(call.init?.body)), payload);

    await assert.rejects(
      () => postSessionClaim(config, payload, (async () => new Response('fail', { status: 403 })) as typeof fetch),
      /HTTP 403/,
    );
  });
});

describe('workspace helpers', () => {
  it('returns undefined for an empty window (no folders and no workspace file)', () => {
    assert.equal(workspaceKey({ folders: [] }), undefined);
    assert.equal(workspaceKey({ workspaceFile: undefined, folders: [] }), undefined);
    assert.equal(workspaceKey({ workspaceFile: '', folders: [] }), undefined);
  });

  it('computes deterministic lowercase sha256 first-32-char hex of workspaceFile when present', () => {
    const wfUri = 'file:///c%3A/dev/heyloop.code-workspace';
    const expected = createHash('sha256').update(wfUri, 'utf8').digest('hex').slice(0, 32);

    const key = workspaceKey({
      workspaceFile: wfUri,
      folders: ['file:///c%3A/dev/a', 'file:///c%3A/dev/b'],
    });
    assert.equal(key, expected);
    assert.equal(key?.length, 32);
    assert.match(key ?? '', /^[a-f0-9]{32}$/);
    // Deterministic across calls and independent of folders when workspaceFile is set
    assert.equal(workspaceKey({ workspaceFile: wfUri, folders: [] }), expected);
  });

  it('computes deterministic lowercase sha256 first-32-char hex of sorted folders joined by newline', () => {
    const f1 = 'file:///c%3A/projects/alpha';
    const f2 = 'file:///c%3A/projects/beta';
    const expectedSingle = createHash('sha256').update(f1, 'utf8').digest('hex').slice(0, 32);
    const expectedMulti = createHash('sha256')
      .update(`${f1}\n${f2}`, 'utf8')
      .digest('hex')
      .slice(0, 32);

    const k1 = workspaceKey({ folders: [f1] });
    const k2 = workspaceKey({ folders: [f2] });
    assert.equal(k1, expectedSingle);
    assert.notEqual(k1, k2);

    // Folder order does not matter and input array is not mutated
    const reversed = [f2, f1];
    const kForward = workspaceKey({ folders: [f1, f2] });
    const kReverse = workspaceKey({ folders: reversed });
    assert.equal(kForward, expectedMulti);
    assert.equal(kReverse, expectedMulti);
    assert.deepEqual(reversed, [f2, f1]);
  });

  it('builds the SSE events URL with id, name, workspace, and optional folder query params', () => {
    const ws = '0123456789abcdef0123456789abcdef';
    const withFolder = eventsUrl(4519, {
      id: 'win-1',
      name: 'heyloop',
      workspace: ws,
      folder: 'E:\\heyloop-wt\\ws-ext',
    });
    const parsedWith = new URL(withFolder);
    assert.equal(parsedWith.origin, 'http://127.0.0.1:4519');
    assert.equal(parsedWith.pathname, '/api/windows/events');
    assert.equal(parsedWith.searchParams.get('id'), 'win-1');
    assert.equal(parsedWith.searchParams.get('name'), 'heyloop');
    assert.equal(parsedWith.searchParams.get('workspace'), ws);
    assert.equal(parsedWith.searchParams.get('folder'), 'E:\\heyloop-wt\\ws-ext');

    const withoutFolder = eventsUrl(4519, {
      id: 'win-2',
      name: 'Untitled window',
      workspace: ws,
    });
    const parsedWithout = new URL(withoutFolder);
    assert.equal(parsedWithout.origin, 'http://127.0.0.1:4519');
    assert.equal(parsedWithout.pathname, '/api/windows/events');
    assert.equal(parsedWithout.searchParams.get('id'), 'win-2');
    assert.equal(parsedWithout.searchParams.get('name'), 'Untitled window');
    assert.equal(parsedWithout.searchParams.get('workspace'), ws);
    assert.equal(parsedWithout.searchParams.has('folder'), false);

    // Validates WindowHello before building URL
    assert.throws(() =>
      eventsUrl(4519, {
        id: 'win-bad',
        name: 'heyloop',
        workspace: 'NOT-HEX',
      }),
    );
  });
});


