import { deriveKeys, open, seal, type PairingKeys } from '@heyloop/protocol/crypto';
import {
  MAX_FRAME_CHARS,
  PhoneFrame,
  RelayServerFrame,
  type DaemonFrame,
  type PushHint,
} from '@heyloop/protocol/relay';
import type { Chat, Envelope } from '@heyloop/protocol';
import type { ApprovalBroker } from './broker.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import { WindowRegistry } from './windows.js';

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_BATCH = 100;
// Base64 expands 4/3 (+40B nonce/MAC and send wrapper); leave 4 KiB plaintext margin under MAX_FRAME_CHARS.
const SYNC_MAX_BYTES = Math.floor((MAX_FRAME_CHARS * 3) / 4) - 4096;
const ENVELOPES_FRAME_OVERHEAD = Buffer.byteLength(JSON.stringify({ type: 'envelopes', envelopes: [] }));

/** Outbound connection to the relay; everything past the relay frame layer is end-to-end encrypted. */
export class RelayClient {
  private ws?: WebSocket;
  private keys: PairingKeys;
  private backoff = 1000;
  private ping?: NodeJS.Timeout;
  private stopped = false;
  private ready = false;
  phoneOnline = false;

  constructor(
    private relay: NonNullable<Config['relay']>,
    private machine: { id: string; name: string },
    private store: Store,
    private broker: ApprovalBroker,
    private windows: WindowRegistry = new WindowRegistry(),
  ) {
    this.keys = deriveKeys(relay.secret);
    store.on('envelope', (envelope) => this.sendFrame({ type: 'envelopes', envelopes: [envelope] }, pushHint(envelope)));
    store.on('chat', (chat) => this.sendFrame({ type: 'chats', machine: this.machine, chats: [chat] }));
    windows.on('change', () => this.sendFrame({ type: 'workspaces', workspaces: this.windows.list() }));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.ping);
    this.ws?.close();
  }

  private connect(): void {
    const base = this.relay.url.replace(/^http/, 'ws').replace(/\/$/, '');
    const ws = new WebSocket(`${base}/rooms/${this.keys.room}/ws?role=daemon`);
    this.ws = ws;

    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'auth', token: this.keys.authToken })));
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', (ev) => {
      clearInterval(this.ping);
      this.ready = false;
      this.phoneOnline = false;
      if (ev.code === 4401) {
        console.error('Relay rejected this pairing. Run "heyloop pair" again.');
        return;
      }
      if (this.stopped) return;
      const delay = this.backoff + Math.random() * 500;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener('error', () => {
      // 'close' follows and handles reconnection.
    });
  }

  private onMessage(raw: string): void {
    if (raw === 'pong') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = RelayServerFrame.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;

    if (frame.t === 'ready') {
      this.ready = true;
      this.backoff = 1000;
      this.ping = setInterval(() => this.ws?.send('ping'), PING_MS);
      console.log('Connected to relay.');
    } else if (frame.t === 'peer') {
      this.phoneOnline = frame.online;
    } else if (frame.t === 'msg') {
      let plain: unknown;
      try {
        plain = open(this.keys.key, frame.data);
      } catch {
        plain = undefined;
      }
      const decoded = PhoneFrame.safeParse(plain);
      if (decoded.success) {
        if (this.store.markProcessed(decoded.data.id)) this.handle(decoded.data);
        else this.replyResult(decoded.data.id); // Phone re-sent an unconfirmed frame.
      }
      this.ws?.send(JSON.stringify({ t: 'ack', id: frame.id }));
    }
  }

  handle(frame: PhoneFrame): void {
    const reply = (ok: boolean, error?: string) => {
      this.store.saveResult(frame.id, ok, error);
      this.sendFrame({ type: 'result', ref: frame.id, ok, error });
    };

    switch (frame.type) {
      case 'sync': {
        this.sendFrame({ type: 'workspaces', workspaces: this.windows.list() });
        const chats = this.store.listChats();
        for (const batch of batchChats(chats, this.machine)) {
          this.sendFrame({ type: 'chats', machine: this.machine, chats: batch });
        }
        for (const chat of chats) {
          const envelopes = this.store.messagesSince(chat.chat_id, frame.cursors[chat.chat_id] ?? 0);
          for (const batch of batchEnvelopes(envelopes)) {
            this.sendFrame({ type: 'envelopes', envelopes: batch });
          }
        }
        return reply(true);
      }
      case 'answer': {
        const result = this.broker.answer(frame.request_id, { option_id: frame.option_id, text: frame.text }, 'phone');
        return result.ok ? reply(true) : reply(false, result.error);
      }
      case 'say':
        if (!this.store.getChat(frame.chat_id)) return reply(false, 'not_found');
        this.store.append(frame.chat_id, 'user', { kind: 'text', text: frame.text });
        return reply(true);
      case 'rename':
        if (!this.store.getChat(frame.chat_id)) return reply(false, 'not_found');
        this.store.renameChat(frame.chat_id, frame.title, true);
        this.store.append(frame.chat_id, 'user', { kind: 'chat_meta', title: frame.title });
        return reply(true);
      case 'presence':
        // Consumed by desktop-first routing (not built yet).
        return reply(true);
      case 'new_chat': {
        if (!this.windows.has(frame.workspace_id)) return reply(false, 'window_offline');
        const chatKey = `phone:${frame.id}`;
        const firstLine = frame.text.split(/\r?\n/, 1)[0]?.trim() || 'New chat';
        const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
        const chat = this.store.createChat('vscode', title, chatKey);
        this.store.append(chat.chat_id, 'user', { kind: 'text', text: frame.text }, true);
        const prompt = `${frame.text}\n\n---\nThis task was started from the HeyLoop phone app. Use chat_key "${chatKey}" on every HeyLoop call for this task so your updates reach the same phone chat.`;
        this.windows.send(frame.workspace_id, { type: 'new_chat', chat_id: chat.chat_id, chat_key: chatKey, prompt });
        return reply(true);
      }
    }
  }

  private replyResult(ref: string): void {
    const prior = this.store.getResult(ref);
    this.sendFrame({ type: 'result', ref, ok: prior?.ok ?? true, error: prior?.error });
  }

  private sendFrame(frame: DaemonFrame, push?: PushHint): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: 'send', data: seal(this.keys.key, frame), push }));
  }
}

export function batchChats(chats: Chat[], machine: { id: string; name: string } = { id: '', name: '' }): Chat[][] {
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'chats', machine, chats: [] }));
  const batches: Chat[][] = [];
  let batch: Chat[] = [];
  let bytes = overhead;
  for (const chat of chats) {
    const chatBytes = Buffer.byteLength(JSON.stringify(chat));
    const added = batch.length === 0 ? chatBytes : 1 + chatBytes;
    if (batch.length > 0 && bytes + added > SYNC_MAX_BYTES) {
      batches.push(batch);
      batch = [chat];
      bytes = overhead + chatBytes;
    } else {
      batch.push(chat);
      bytes += added;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function batchEnvelopes(envelopes: Envelope[]): Envelope[][] {
  const batches: Envelope[][] = [];
  let batch: Envelope[] = [];
  let bytes = ENVELOPES_FRAME_OVERHEAD;
  for (const env of envelopes) {
    const envBytes = Buffer.byteLength(JSON.stringify(env));
    const added = batch.length === 0 ? envBytes : 1 + envBytes;
    if (batch.length > 0 && (batch.length >= SYNC_BATCH || bytes + added > SYNC_MAX_BYTES)) {
      batches.push(batch);
      batch = [env];
      bytes = ENVELOPES_FRAME_OVERHEAD + envBytes;
    } else {
      batch.push(env);
      bytes += added;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function pushHint({ sender, body }: Envelope): PushHint | undefined {
  if (sender !== 'agent') return undefined;
  if (body.kind === 'approval_request') return 'approval';
  return body.kind === 'status' && body.notify ? 'update' : undefined;
}
