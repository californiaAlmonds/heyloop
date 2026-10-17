import type { Chat, Envelope } from '@heyloop/protocol';
import { deriveKeys, open, seal, type PairingKeys, type PairingLink } from '@heyloop/protocol/crypto';
import { DaemonFrame, RelayServerFrame, type PhoneFrame, type Workspace } from '@heyloop/protocol/relay';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { Cache } from './cache';
import { getPushToken, watchPushToken } from './push';

const PAIRING_KEY = 'heyloop.pairing';
const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const RESULT_TIMEOUT_MS = 15_000;

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

/** `error` is a daemon code, or 'offline' (never sent) / 'unconfirmed' (sent, no result yet; resent on reconnect). */
export interface SubmitResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface Machine {
  id: string;
  name: string;
}

export interface Snapshot {
  loaded: boolean;
  /** Pairing metadata only; the secret never leaves this module. */
  pairing: { relay: string; name: string } | null;
  machine: Machine | null;
  status: ConnectionStatus;
  computerOnline: boolean;
  workspaces: Workspace[];
  chats: Chat[];
  messages: Record<string, Envelope[]>;
  favourites: ReadonlySet<string>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutgoingFrame = DistributiveOmit<PhoneFrame, 'id'>;

const EMPTY: Snapshot = {
  loaded: false,
  pairing: null,
  machine: null,
  status: 'offline',
  computerOnline: false,
  workspaces: [],
  chats: [],
  messages: {},
  favourites: new Set(),
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
  private pending = new Map<string, OutgoingFrame>();
  private waiters = new Map<string, (r: Omit<SubmitResult, 'id'>) => void>();
  private cache = new Cache();
  private generation = 0;
  private initialized?: Promise<void>;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  init(): Promise<void> {
    this.initialized ??= (async () => {
      const raw = await SecureStore.getItemAsync(PAIRING_KEY);
      if (raw) await this.activate(JSON.parse(raw) as PairingLink);
      this.update({ loaded: true });
      AppState.addEventListener('change', (state) => {
        if (state === 'background') {
          // A backgrounded socket can look alive for minutes; staying disconnected lets the relay ring the phone instead.
          this.disconnect();
          if (this.keys && this.snapshot.status !== 'unauthorized') {
            this.update({ status: 'offline', computerOnline: false, workspaces: this.closeWorkspaces() });
          }
        } else if (state === 'active' && this.keys && this.snapshot.status === 'offline') this.reconnectNow();
      });
      watchPushToken((token) => this.registerPush(token));
    })();
    return this.initialized;
  }

  async pair(link: PairingLink): Promise<void> {
    await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(link));
    this.reset();
    await this.activate(link);
  }

  async unpair(): Promise<void> {
    if (this.ws && this.snapshot.status === 'online') {
      // Best effort: stop the old room from ringing this phone.
      this.ws.send(JSON.stringify({ t: 'push_off' }));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await SecureStore.deleteItemAsync(PAIRING_KEY);
    this.reset();
    this.cache.clear();
  }

  toggleFavourite(chatId: string): boolean {
    const next = new Set(this.snapshot.favourites);
    const added = !next.has(chatId);
    if (added) next.add(chatId);
    else next.delete(chatId);
    this.cache.setFavourite(chatId, added);
    this.update({ favourites: next });
    return added;
  }

  reconnectNow(): void {
    if (!this.keys) return;
    this.disconnect();
    this.backoff = 1000;
    this.connect();
  }

  send(frame: OutgoingFrame): boolean {
    if (!this.keys || !this.ws || this.snapshot.status !== 'online') return false;
    this.transmit(randomUUID(), frame);
    return true;
  }

  /**
   * Sends a user action and waits for the daemon's result. After 'unconfirmed' the frame stays queued and is
   * resent with the same id on reconnect; pass that id again to retry so the daemon dedupes it.
   */
  submit(frame: OutgoingFrame, id: string = randomUUID()): Promise<SubmitResult> {
    if (!this.keys || !this.ws || this.snapshot.status !== 'online') {
      return Promise.resolve({ id, ok: false, error: 'offline' });
    }
    this.waiters.get(id)?.({ ok: false, error: 'unconfirmed' });
    this.pending.set(id, frame);
    this.transmit(id, frame);
    return new Promise((resolve) => {
      const settle = (r: Omit<SubmitResult, 'id'>) => {
        clearTimeout(timer);
        if (this.waiters.get(id) === settle) this.waiters.delete(id);
        resolve({ id, ...r });
      };
      const timer = setTimeout(() => settle({ ok: false, error: 'unconfirmed' }), RESULT_TIMEOUT_MS);
      this.waiters.set(id, settle);
    });
  }

  /** Stops resending an unconfirmed action the user gave up on. */
  discard(id: string): void {
    this.pending.delete(id);
  }

  private transmit(id: string, frame: OutgoingFrame): void {
    if (!this.keys || !this.ws) return;
    this.ws.send(JSON.stringify({ t: 'send', data: seal(this.keys.key, { ...frame, id }) }));
  }

  private async activate(link: PairingLink): Promise<void> {
    const generation = ++this.generation;
    const keys = deriveKeys(link.secret);
    this.update({ pairing: { relay: link.relay, name: link.name } });
    // Restore before connecting so the first sync sends the saved cursors.
    const cached = await this.cache.attach(keys.room, keys.cacheKey);
    if (generation !== this.generation) return;
    this.relay = link.relay;
    this.keys = keys;
    if (cached) {
      this.cursors = cached.cursors;
      const chatIds = new Set(cached.chats.map((c) => c.chat_id));
      this.update({
        workspaces: cached.workspaces.map((w) => ({ ...w, open: false })),
        chats: cached.chats,
        messages: cached.messages,
        favourites: this.pruneFavourites(cached.favourites, chatIds),
      });
    }
    this.connect();
  }

  private pruneFavourites(
    favourites: Iterable<string>,
    chats: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  ): Set<string> {
    if (chats.size === 0) return new Set(favourites);
    const next = new Set<string>();
    for (const id of favourites) {
      if (chats.has(id)) next.add(id);
      else this.cache.setFavourite(id, false);
    }
    return next;
  }

  private reset(): void {
    this.generation++;
    this.disconnect();
    for (const settle of [...this.waiters.values()]) settle({ ok: false, error: 'offline' });
    this.pending.clear();
    this.relay = undefined;
    this.keys = undefined;
    this.cursors = {};
    this.snapshot = { ...EMPTY, loaded: true, favourites: new Set() };
    this.emit();
  }

  private closeWorkspaces(): Workspace[] {
    return this.snapshot.workspaces.map((w) => ({ ...w, open: false }));
  }

  private registerPush(token: string): void {
    if (this.ws && this.snapshot.status === 'online') this.ws.send(JSON.stringify({ t: 'push', token }));
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
    if (AppState.currentState === 'background') return;
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
      if (ev.code === 4401) {
        return this.update({ status: 'unauthorized', computerOnline: false, workspaces: this.closeWorkspaces() });
      }
      this.update({ status: 'offline', computerOnline: false, workspaces: this.closeWorkspaces() });
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
      for (const [id, pending] of this.pending) this.transmit(id, pending);
      void getPushToken().then((token) => token && this.registerPush(token));
    } else if (frame.t === 'peer') {
      this.update(
        frame.online ? { computerOnline: true } : { computerOnline: false, workspaces: this.closeWorkspaces() },
      );
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
      this.update({
        machine: frame.machine,
        chats: [...byId.values()],
        favourites: this.pruneFavourites(this.snapshot.favourites, byId),
      });
      this.cache.persist({ chats: frame.chats, envelopes: [], cursors: {} });
    } else if (frame.type === 'envelopes') {
      const messages = { ...this.snapshot.messages };
      const fresh: Envelope[] = [];
      for (const env of frame.envelopes) {
        const list = messages[env.chat_id] ?? [];
        if (list.some((e) => e.seq === env.seq)) continue;
        messages[env.chat_id] = [...list, env].sort((a, b) => a.seq - b.seq);
        fresh.push(env);
      }
      const cursors: Record<string, number> = {};
      for (const chatId of new Set(frame.envelopes.map((e) => e.chat_id))) {
        // Only advance over contiguous seqs so a gap is refilled by the next sync.
        const seqs = new Set(messages[chatId].map((e) => e.seq));
        let cursor = this.cursors[chatId] ?? 0;
        while (seqs.has(cursor + 1)) cursor++;
        this.cursors[chatId] = cursor;
        cursors[chatId] = cursor;
      }
      this.update({ messages });
      this.cache.persist({ chats: [], envelopes: fresh, cursors });
    } else if (frame.type === 'workspaces') {
      const workspaces = frame.workspaces.map((w) => ({ ...w, open: w.open ?? true }));
      this.update({ workspaces });
      this.cache.setWorkspaces(workspaces);
    } else if (frame.type === 'result') {
      this.pending.delete(frame.ref);
      this.waiters.get(frame.ref)?.({ ok: frame.ok, error: frame.error });
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
