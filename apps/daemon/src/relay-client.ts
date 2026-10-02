import { deriveKeys, open, seal, type PairingKeys } from '@heyloop/protocol/crypto';
import { PhoneFrame, RelayServerFrame, type DaemonFrame } from '@heyloop/protocol/relay';
import type { ApprovalBroker } from './broker.js';
import type { Config } from './config.js';
import type { Store } from './store.js';

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_BATCH = 100;

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
  ) {
    this.keys = deriveKeys(relay.secret);
    store.on('envelope', (envelope) => this.sendFrame({ type: 'envelopes', envelopes: [envelope] }));
    store.on('chat', (chat) => this.sendFrame({ type: 'chats', machine: this.machine, chats: [chat] }));
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
    const parsed = RelayServerFrame.safeParse(JSON.parse(raw));
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
      const decoded = PhoneFrame.safeParse(open(this.keys.key, frame.data));
      if (decoded.success && this.store.markProcessed(decoded.data.id)) this.handle(decoded.data);
      this.ws?.send(JSON.stringify({ t: 'ack', id: frame.id }));
    }
  }

  private handle(frame: PhoneFrame): void {
    const reply = (ok: boolean, error?: string) => this.sendFrame({ type: 'result', ref: frame.id, ok, error });

    switch (frame.type) {
      case 'sync': {
        const chats = this.store.listChats();
        this.sendFrame({ type: 'chats', machine: this.machine, chats });
        for (const chat of chats) {
          const envelopes = this.store.messagesSince(chat.chat_id, frame.cursors[chat.chat_id] ?? 0);
          for (let i = 0; i < envelopes.length; i += SYNC_BATCH) {
            this.sendFrame({ type: 'envelopes', envelopes: envelopes.slice(i, i + SYNC_BATCH) });
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
    }
  }

  private sendFrame(frame: DaemonFrame): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: 'send', data: seal(this.keys.key, frame) }));
  }
}
