// End-to-end check through the relay with a simulated phone.
// Needs: relay (`npm run dev -w @heyloop/relay`), `heyloop pair --relay http://127.0.0.1:8787`, daemon running.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ExtensionEvent } from '@heyloop/protocol';
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

  registerPush(token: string): void {
    this.ws.send(JSON.stringify({ t: 'push', token }));
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

const hasEnvelope = (kind: string, chatId?: string) => (f: DaemonFrame) =>
  f.type === 'envelopes' && f.envelopes.some((e) => e.body.kind === kind && (!chatId || e.chat_id === chatId));

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
const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  (await mcp.callTool({ name, arguments: args, _meta: meta })).structuredContent as Record<string, any>;

const intruder = new Phone();
check('wrong token is rejected', (await intruder.connect('x'.repeat(43))) === 4401);

const rogue = new WebSocket(`${wsBase}/rooms/${keys.room}/ws?role=daemon`);
const rogueClose = await new Promise<number>((resolve) => {
  rogue.addEventListener('open', () => rogue.send(JSON.stringify({ t: 'auth', token: keys.authToken })));
  rogue.addEventListener('message', (ev) => {
    if (JSON.parse(String(ev.data)).t === 'ready') rogue.send(JSON.stringify({ t: 'push', token: 'x' }));
  });
  rogue.addEventListener('close', (ev) => resolve(ev.code));
});
check('daemon cannot register a push token', rogueClose === 1008);

const status = await call('send_status_update', { title: 'Relay smoke', summary: 'Relay test started', level: 'info' });

const phone = new Phone();
check('phone authenticates', (await phone.connect()) === 'ready');
phone.registerPush('smoke-test-token');
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
const req = await phone.waitFor(hasEnvelope('approval_request', status.chat_id));
const requestId = req.type === 'envelopes' ? (req.envelopes.find((e) => e.body.kind === 'approval_request' && e.chat_id === status.chat_id)!.body as { request_id: string }).request_id : '';
phone.send({ type: 'answer', id: ulid(), request_id: requestId, option_id: 'approve' });
const answered = await asking;
check('phone answer unblocks the agent', answered.status === 'answered' && answered.answered_via === 'phone');

const dupId = ulid();
phone.send({ type: 'say', id: dupId, chat_id: status.chat_id, text: 'also update the changelog' });
phone.send({ type: 'say', id: dupId, chat_id: status.chat_id, text: 'also update the changelog' });
await phone.waitFor((f) => f.type === 'result' && f.ref === dupId);
for (let i = 0; i < 50 && phone.frames.filter((f) => f.type === 'result' && f.ref === dupId).length < 2; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
check(
  'duplicate frame gets the original result again',
  phone.frames.filter((f) => f.type === 'result' && f.ref === dupId && f.ok).length === 2,
);
const withInbox = await call('send_status_update', { chat_id: status.chat_id, summary: 'Migrated', level: 'success' });
check('phone message reaches inbox exactly once', withInbox.inbox.length === 1);

const offlineChatId = ulid();
phone.send({ type: 'new_chat', id: offlineChatId, workspace_id: '00000000', text: 'Start task on missing window' });
const offlineResult = await phone.waitFor((f) => f.type === 'result' && f.ref === offlineChatId);
check(
  'new_chat with unknown window returns window_offline',
  offlineResult.type === 'result' && !offlineResult.ok && offlineResult.error === 'window_offline',
);

const makeSseReader = (res: Response) => {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuf = '';
  return async (match: (ev: ExtensionEvent) => boolean = () => true): Promise<ExtensionEvent | undefined> => {
    while (true) {
      const idx = sseBuf.indexOf('\n\n');
      if (idx !== -1) {
        const block = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx + 2);
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const ev = ExtensionEvent.parse(JSON.parse(dataLine.slice(6)));
          if (match(ev)) return ev;
        }
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return undefined;
      sseBuf += decoder.decode(value, { stream: true });
    }
  };
};

const extAc = new AbortController();
const winId = `win-${ulid()}`;
const workspaceId = Buffer.from(ulid()).toString('hex').slice(0, 16);
const extRes = await fetch(
  `http://127.0.0.1:${config.port}/api/windows/events?id=${encodeURIComponent(winId)}&name=smoke-workspace&workspace=${workspaceId}`,
  { headers: { Authorization: `Bearer ${config.token}` }, signal: extAc.signal },
);
const workspacesFrame = await phone.waitFor(
  (f) => f.type === 'workspaces' && f.workspaces.some((w) => w.id === workspaceId && w.name === 'smoke-workspace' && w.open === true),
);
check('phone receives workspaces frame listing connected window', workspacesFrame.type === 'workspaces');

const newChatId = ulid();
phone.send({ type: 'new_chat', id: newChatId, workspace_id: workspaceId, text: 'Build new feature from phone' });
const newChatResult = await phone.waitFor((f) => f.type === 'result' && f.ref === newChatId);

const readExtEvent = makeSseReader(extRes);

const extEvent = await readExtEvent((ev) => ev.type === 'new_chat');
check(
  'new_chat succeeds and emits extension event with chat_key in prompt',
  newChatResult.type === 'result' &&
    newChatResult.ok &&
    extEvent?.type === 'new_chat' &&
    extEvent.chat_key === `phone:${newChatId}` &&
    extEvent.prompt.includes(`phone:${newChatId}`),
);

const sessionId = `sess-${ulid()}`;
await call('check_inbox', { chat_id: status.chat_id }, { 'vscode.conversationId': sessionId });
const whoseEvent = await readExtEvent((ev) => ev.type === 'whose_session' && ev.session_id === sessionId);
check('unclaimed session broadcasts whose_session to connected window', whoseEvent?.type === 'whose_session');
const claimRes = await fetch(`http://127.0.0.1:${config.port}/api/windows/claim`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ window_id: winId, session_id: sessionId }),
});
check('window claims session and sets workspace_id on chat', claimRes.status === 200);

const promptSayId = ulid();
phone.send({ type: 'say', id: promptSayId, chat_id: status.chat_id, text: 'follow up into copilot chat' });
await phone.waitFor((f) => f.type === 'result' && f.ref === promptSayId && f.ok);
const promptEvent = await readExtEvent((ev) => ev.type === 'prompt');
check(
  'phone say on chat with session_id emits prompt event to connected window',
  promptEvent?.type === 'prompt' &&
    promptEvent.chat_id === status.chat_id &&
    promptEvent.session_id === sessionId &&
    promptEvent.text === 'follow up into copilot chat',
);
const ackRes = await fetch(`http://127.0.0.1:${config.port}/api/windows/delivered`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ message_id: promptEvent?.type === 'prompt' ? promptEvent.message_id : '', window_id: winId }),
});
const afterAck = await call('check_inbox', { chat_id: status.chat_id });
check('delivered prompt is marked consumed and omitted from check_inbox', ackRes.status === 200 && afterAck.inbox.length === 0);
extAc.abort();
await phone.waitFor(
  (f) => f.type === 'workspaces' && f.workspaces.some((w) => w.id === workspaceId && w.open === false),
);

const queuedSayId = ulid();
phone.send({ type: 'say', id: queuedSayId, chat_id: status.chat_id, text: 'queued while workspace closed' });
await phone.waitFor((f) => f.type === 'result' && f.ref === queuedSayId && f.ok);

const extAc2 = new AbortController();
const winId2 = `win-${ulid()}`;
const extRes2 = await fetch(
  `http://127.0.0.1:${config.port}/api/windows/events?id=${encodeURIComponent(winId2)}&name=smoke-workspace&workspace=${workspaceId}`,
  { headers: { Authorization: `Bearer ${config.token}` }, signal: extAc2.signal },
);
const readExtEvent2 = makeSseReader(extRes2);
const queuedPrompt = await readExtEvent2((ev) => ev.type === 'prompt');
check(
  'queued say is delivered as a prompt when the window connects',
  queuedPrompt?.type === 'prompt' &&
    queuedPrompt.chat_id === status.chat_id &&
    queuedPrompt.session_id === sessionId &&
    queuedPrompt.text === 'queued while workspace closed',
);
extAc2.abort();

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
