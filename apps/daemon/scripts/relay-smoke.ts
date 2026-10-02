// End-to-end check through the relay with a simulated phone.
// Needs: relay (`npm run dev -w @heyloop/relay`), `heyloop pair --relay http://127.0.0.1:8787`, daemon running.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveKeys, open, seal } from '@heyloop/protocol/crypto';
import { DaemonFrame, type PhoneFrame } from '@heyloop/protocol/relay';
import { ulid } from 'ulid';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.relay) throw new Error('Run "heyloop pair --relay http://127.0.0.1:8787" first.');
const keys = deriveKeys(config.relay.secret);
const wsBase = config.relay.url.replace(/^http/, 'ws');

class Phone {
  frames: DaemonFrame[] = [];
  private ws!: WebSocket;
  private waiters: { match: (f: DaemonFrame) => boolean; resolve: (f: DaemonFrame) => void }[] = [];

  connect(token = keys.authToken): Promise<number | 'ready'> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`${wsBase}/rooms/${keys.room}/ws?role=phone`);
      this.ws.addEventListener('open', () => this.ws.send(JSON.stringify({ t: 'auth', token })));
      this.ws.addEventListener('close', (ev) => resolve(ev.code));
      this.ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(String(ev.data));
        if (frame.t === 'ready') resolve('ready');
        if (frame.t !== 'msg') return;
        const decoded = DaemonFrame.parse(open(keys.key, frame.data));
        this.ws.send(JSON.stringify({ t: 'ack', id: frame.id }));
        this.frames.push(decoded);
        this.waiters = this.waiters.filter((w) => (w.match(decoded) ? (w.resolve(decoded), false) : true));
      });
    });
  }

  send(frame: PhoneFrame): void {
    this.ws.send(JSON.stringify({ t: 'send', data: seal(keys.key, frame) }));
  }

  waitFor(match: (f: DaemonFrame) => boolean, ms = 5000): Promise<DaemonFrame> {
    const found = this.frames.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      this.waiters.push({ match, resolve });
      setTimeout(() => reject(new Error('Timed out waiting for frame')), ms);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.addEventListener('close', () => resolve());
      this.ws.close();
    });
  }
}

const hasEnvelope = (kind: string) => (f: DaemonFrame) =>
  f.type === 'envelopes' && f.envelopes.some((e) => e.body.kind === kind);

const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
};

const mcp = new Client({ name: 'heyloop-relay-smoke', version: '0.0.0' });
await mcp.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }),
);
const call = async (name: string, args: Record<string, unknown>) =>
  (await mcp.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

const intruder = new Phone();
check('wrong token is rejected', (await intruder.connect('x'.repeat(43))) === 4401);

const status = await call('send_status_update', { title: 'Relay smoke', summary: 'Relay test started', level: 'info' });

const phone = new Phone();
check('phone authenticates', (await phone.connect()) === 'ready');
phone.send({ type: 'sync', id: ulid(), cursors: {} });
const chats = await phone.waitFor((f) => f.type === 'chats' && f.chats.some((c) => c.chat_id === status.chat_id));
check('sync returns chat list', chats.type === 'chats');
await phone.waitFor(hasEnvelope('status'));
check('sync returns history', true);

const asking = call('ask_human_approval', {
  chat_id: status.chat_id,
  question: 'Run database migration?',
  command: 'npm run migrate',
  risk: 'high',
  input: 'confirm',
  wait_seconds: 10,
});
const req = await phone.waitFor(hasEnvelope('approval_request'));
const requestId = req.type === 'envelopes' ? (req.envelopes.find((e) => e.body.kind === 'approval_request')!.body as { request_id: string }).request_id : '';
phone.send({ type: 'answer', id: ulid(), request_id: requestId, option_id: 'approve' });
const answered = await asking;
check('phone answer unblocks the agent', answered.status === 'answered' && answered.answered_via === 'phone');

const dupId = ulid();
phone.send({ type: 'say', id: dupId, chat_id: status.chat_id, text: 'also update the changelog' });
phone.send({ type: 'say', id: dupId, chat_id: status.chat_id, text: 'also update the changelog' });
await phone.waitFor((f) => f.type === 'result' && f.ref === dupId);
const withInbox = await call('send_status_update', { chat_id: status.chat_id, summary: 'Migrated', level: 'success' });
check('phone message reaches inbox exactly once', withInbox.inbox.length === 1);

await phone.close();
await call('send_status_update', { chat_id: status.chat_id, summary: 'Sent while phone offline', level: 'warning' });
const back = new Phone();
await back.connect();
const queued = await back.waitFor(
  (f) => f.type === 'envelopes' && f.envelopes.some((e) => e.body.kind === 'status' && e.body.summary === 'Sent while phone offline'),
);
check('offline messages are queued and delivered', !!queued);
await back.close();

await mcp.close();
