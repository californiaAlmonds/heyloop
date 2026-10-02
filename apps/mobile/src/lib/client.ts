import type { Chat, Envelope } from '@heyloop/protocol';
import { deriveKeys, open, seal, type PairingKeys, type PairingLink } from '@heyloop/protocol/crypto';
import { DaemonFrame, RelayServerFrame, type PhoneFrame } from '@heyloop/protocol/relay';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const PAIRING_KEY = 'heyloop.pairing';
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

export interface Snapshot {
  loaded: boolean;
  /** Pairing metadata only; the secret never leaves this module. */
  pairing: { relay: string; name: string } | null;
  status: ConnectionStatus;
  computerOnline: boolean;
  chats: Chat[];
  messages: Record<string, Envelope[]>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OutgoingFrame = DistributiveOmit<PhoneFrame, 'id'>;

const EMPTY: Snapshot = {
  loaded: false,
  pairing: null,
  status: 'offline',
  computerOnline: false,
  chats: [],
  messages: {},
};

class HeyLoopClient {
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private relay?: string;
  private keys?: PairingKeys;
  private ws?: WebSocket;
  private ping?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 1000;
  private cursors: Record<string, number> = {};
  private initialized?: Promise<void>;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  init(): Promise<void> {
    this.initialized ??= (async () => {
      const raw = await SecureStore.getItemAsync(PAIRING_KEY);
      this.update({ loaded: true });
      if (raw) this.activate(JSON.parse(raw) as PairingLink);
      AppState.addEventListener('change', (state) => {
        if (state === 'active' && this.keys && this.snapshot.status === 'offline') this.reconnectNow();
      });
    })();
    return this.initialized;
  }

  async pair(link: PairingLink): Promise<void> {
    await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(link));
    this.reset();
    this.activate(link);
  }

  async unpair(): Promise<void> {
    await SecureStore.deleteItemAsync(PAIRING_KEY);
    this.reset();
  }

  reconnectNow(): void {
    if (!this.keys) return;
    this.disconnect();
    this.backoff = 1000;
    this.connect();
  }

  send(frame: OutgoingFrame): boolean {
    if (!this.keys || !this.ws || this.snapshot.status !== 'online') return false;
    const data = seal(this.keys.key, { ...frame, id: randomUUID() });
    this.ws.send(JSON.stringify({ t: 'send', data }));
    return true;
  }

  private activate(link: PairingLink): void {
    this.relay = link.relay;
    this.keys = deriveKeys(link.secret);
    this.update({ pairing: { relay: link.relay, name: link.name } });
    this.connect();
  }

  private reset(): void {
    this.disconnect();
    this.relay = undefined;
    this.keys = undefined;
    this.cursors = {};
    this.snapshot = { ...EMPTY, loaded: true };
    this.emit();
  }

  private disconnect(): void {
    const ws = this.ws;
    this.ws = undefined;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    ws?.close();
  }

  private connect(): void {
    const keys = this.keys;
    if (!keys || !this.relay) return;
    const ws = new WebSocket(`${this.relay.replace(/^http/, 'ws')}/rooms/${keys.room}/ws?role=phone`);
    this.ws = ws;
    this.update({ status: 'connecting' });

    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: keys.authToken }));
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(String(ev.data));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.ping);
      // 4401 also means the daemon hasn't claimed the room yet; the user retries manually.
      if (ev.code === 4401) return this.update({ status: 'unauthorized', computerOnline: false });
      this.update({ status: 'offline', computerOnline: false });
      const delay = this.backoff + Math.random() * 500;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.retry = setTimeout(() => this.connect(), delay);
    };
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
      this.backoff = 1000;
      clearInterval(this.ping);
      this.ping = setInterval(() => this.ws?.send('ping'), PING_MS);
      this.update({ status: 'online' });
    } else if (frame.t === 'peer') {
      this.update({ computerOnline: frame.online });
      // The relay sends peer status right after ready, so this also covers the initial sync.
      if (frame.online) this.send({ type: 'sync', cursors: { ...this.cursors } });
    } else if (frame.t === 'msg') {
      let plain: unknown;
      try {
        plain = open(this.keys!.key, frame.data);
      } catch {
        plain = undefined;
      }
      const decoded = DaemonFrame.safeParse(plain);
      if (decoded.success) this.apply(decoded.data);
      this.ws?.send(JSON.stringify({ t: 'ack', id: frame.id }));
    }
  }

  private apply(frame: DaemonFrame): void {
    if (frame.type === 'chats') {
      const byId = new Map(this.snapshot.chats.map((c) => [c.chat_id, c]));
      for (const chat of frame.chats) byId.set(chat.chat_id, chat);
      this.update({ chats: [...byId.values()] });
    } else if (frame.type === 'envelopes') {
      const messages = { ...this.snapshot.messages };
      for (const env of frame.envelopes) {
        const list = messages[env.chat_id] ?? [];
        if (list.some((e) => e.seq === env.seq)) continue;
        messages[env.chat_id] = [...list, env].sort((a, b) => a.seq - b.seq);
      }
      for (const chatId of new Set(frame.envelopes.map((e) => e.chat_id))) {
        // Only advance over contiguous seqs so a gap is refilled by the next sync.
        const seqs = new Set(messages[chatId].map((e) => e.seq));
        let cursor = this.cursors[chatId] ?? 0;
        while (seqs.has(cursor + 1)) cursor++;
        this.cursors[chatId] = cursor;
      }
      this.update({ messages });
    }
  }

  private update(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const client = new HeyLoopClient();

export function useHeyLoop(): Snapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}
