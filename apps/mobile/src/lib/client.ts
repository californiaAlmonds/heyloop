import type { Chat, Envelope } from '@heyloop/protocol';
import {
  deriveKeys,
  normalizeRelayUrl,
  open,
  seal,
  type PairingKeys,
  type PairingLink,
} from '@heyloop/protocol/crypto';
import { DaemonFrame, RelayServerFrame, type PhoneFrame, type Workspace } from '@heyloop/protocol/relay';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { Cache } from './cache';
import { getPushToken, watchPushToken } from './push';

const PAIRINGS_KEY = 'heyloop.pairings';
const LEGACY_PAIRING_KEY = 'heyloop.pairing';
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

export interface PairedMachine {
  room: string;
  name: string;
  relay: string;
  machine: Machine | null;
  status: ConnectionStatus;
  computerOnline: boolean;
  workspaces: Workspace[];
}

export interface PairedChat extends Chat {
  room: string;
}

export function chatKey(room: string, chatId: string): string {
  return `${room}:${chatId}`;
}

export interface Snapshot {
  loaded: boolean;
  storageError?: string;
  machines: PairedMachine[];
  chats: PairedChat[];
  messages: Record<string, Envelope[]>;
  favourites: ReadonlySet<string>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OutgoingFrame = DistributiveOmit<PhoneFrame, 'id'>;

const EMPTY: Snapshot = {
  loaded: false,
  machines: [],
  chats: [],
  messages: {},
  favourites: new Set(),
};

function parseStoredPairingLink(raw: unknown): { link: PairingLink; keys: PairingKeys } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.relay !== 'string' ||
    typeof candidate.secret !== 'string' ||
    typeof candidate.name !== 'string'
  ) {
    return undefined;
  }
  try {
    const relay = normalizeRelayUrl(candidate.relay);
    const name = (candidate.name || 'Computer').slice(0, 80);
    const keys = deriveKeys(candidate.secret);
    return { link: { relay, secret: candidate.secret, name }, keys };
  } catch {
    return undefined;
  }
}

class PairingConnection {
  readonly room: string;
  status: ConnectionStatus = 'offline';
  computerOnline = false;
  machine: Machine | null = null;
  workspaces: Workspace[] = [];
  chats = new Map<string, PairedChat>();
  messages: Record<string, Envelope[]> = {};
  favourites = new Set<string>();

  private link: PairingLink;
  private keys: PairingKeys;
  private ws?: WebSocket;
  private ping?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 1000;
  private cursors: Record<string, number> = {};
  private pending = new Map<string, OutgoingFrame>();
  private waiters = new Map<string, (r: Omit<SubmitResult, 'id'>) => void>();
  private generation = 0;
  private disposed = false;

  constructor(
    link: PairingLink,
    keys: PairingKeys,
    private readonly cache: Cache,
    private readonly onChange: () => void,
  ) {
    this.room = keys.room;
    this.link = link;
    this.keys = keys;
  }

  toMachineState(): PairedMachine {
    return {
      room: this.room,
      name: this.machine?.name ?? this.link.name,
      relay: this.link.relay,
      machine: this.machine,
      status: this.status,
      computerOnline: this.computerOnline,
      workspaces: this.workspaces,
    };
  }

  reconfigure(link: PairingLink, keys: PairingKeys): void {
    this.generation++;
    this.disconnect();
    for (const settle of [...this.waiters.values()]) settle({ ok: false, error: 'offline' });
    this.pending.clear();
    this.link = link;
    this.keys = keys;
    this.backoff = 1000;
    this.status = 'offline';
    this.computerOnline = false;
    this.workspaces = this.closeWorkspaces();
  }

  async activate(): Promise<void> {
    const generation = ++this.generation;
    // Restore before connecting so the first sync sends the saved cursors.
    const cached = await this.cache.attach(this.keys.room, this.keys.cacheKey);
    if (this.disposed || generation !== this.generation) return;
    if (cached) {
      this.cursors = cached.cursors;
      this.workspaces = cached.workspaces.map((w) => ({ ...w, open: false }));
      this.chats = new Map(cached.chats.map((c) => [c.chat_id, { ...c, room: this.room }]));
      this.messages = cached.messages;
      this.favourites = this.pruneFavourites(this.normalizeFavourites(cached.favourites), this.chats);
      this.onChange();
    }
    this.connect();
  }

  async sendPushOff(): Promise<void> {
    if (this.ws && this.status === 'online') {
      // Best effort: stop this room from ringing the phone.
      this.ws.send(JSON.stringify({ t: 'push_off' }));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  destroy(): void {
    this.disposed = true;
    this.generation++;
    this.disconnect();
    for (const settle of [...this.waiters.values()]) settle({ ok: false, error: 'offline' });
    this.pending.clear();
  }

  onBackground(): void {
    this.disconnect();
    if (this.status !== 'unauthorized') {
      this.status = 'offline';
      this.computerOnline = false;
      this.workspaces = this.closeWorkspaces();
    }
  }

  reconnectNow(): void {
    if (this.disposed) return;
    this.disconnect();
    this.backoff = 1000;
    this.connect();
  }

  registerPush(token: string): void {
    if (this.ws && this.status === 'online') this.ws.send(JSON.stringify({ t: 'push', token }));
  }

  send(frame: OutgoingFrame): boolean {
    if (!this.ws || this.status !== 'online') return false;
    this.transmit(randomUUID(), frame);
    return true;
  }

  submit(frame: OutgoingFrame, id: string = randomUUID()): Promise<SubmitResult> {
    if (!this.ws || this.status !== 'online') {
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

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  discard(id: string): void {
    this.pending.delete(id);
  }

  private transmit(id: string, frame: OutgoingFrame): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ t: 'send', data: seal(this.keys.key, { ...frame, id }) }));
  }

  private normalizeFavourites(stored: Iterable<string>): Set<string> {
    const prefix = `${this.room}:`;
    const next = new Set<string>();
    for (const entry of stored) {
      const chatId = entry.startsWith(prefix) ? entry.slice(prefix.length) : '';
      if (chatId) {
        next.add(entry);
      } else {
        this.cache.setFavourite(this.room, entry, false);
      }
    }
    return next;
  }

  private pruneFavourites(
    favourites: Iterable<string>,
    chats: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  ): Set<string> {
    if (chats.size === 0) return new Set(favourites);
    const prefix = `${this.room}:`;
    const next = new Set<string>();
    for (const key of favourites) {
      const chatId = key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
      if (chatId && chats.has(chatId)) next.add(key);
      else this.cache.setFavourite(this.room, key, false);
    }
    return next;
  }

  private closeWorkspaces(): Workspace[] {
    return this.workspaces.map((w) => ({ ...w, open: false }));
  }

  private disconnect(): void {
    const ws = this.ws;
    this.ws = undefined;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    ws?.close();
  }

  private connect(): void {
    if (this.disposed || AppState.currentState === 'background') return;
    const ws = new WebSocket(`${this.link.relay.replace(/^http/, 'ws')}/rooms/${this.keys.room}/ws?role=phone`);
    this.ws = ws;
    this.status = 'connecting';
    this.onChange();

    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.keys.authToken }));
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(String(ev.data));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.ping);
      this.computerOnline = false;
      this.workspaces = this.closeWorkspaces();
      // 4401 also means the daemon hasn't claimed the room yet; the user retries manually.
      if (ev.code === 4401) {
        this.status = 'unauthorized';
        this.onChange();
        return;
      }
      this.status = 'offline';
      this.onChange();
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
      this.status = 'online';
      this.onChange();
      for (const [id, pending] of this.pending) this.transmit(id, pending);
      void getPushToken().then((token) => token && this.registerPush(token));
    } else if (frame.t === 'peer') {
      if (frame.online) {
        this.computerOnline = true;
      } else {
        this.computerOnline = false;
        this.workspaces = this.closeWorkspaces();
      }
      this.onChange();
      // The relay sends peer status right after ready, so this also covers the initial sync.
      if (frame.online) this.send({ type: 'sync', cursors: { ...this.cursors } });
    } else if (frame.t === 'msg') {
      let plain: unknown;
      try {
        plain = open(this.keys.key, frame.data);
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
      this.machine = frame.machine;
      for (const chat of frame.chats) {
        this.chats.set(chat.chat_id, { ...chat, room: this.room });
      }
      this.favourites = this.pruneFavourites(this.favourites, this.chats);
      this.onChange();
      this.cache.persist(this.room, this.keys.cacheKey, { chats: frame.chats, envelopes: [], cursors: {} });
    } else if (frame.type === 'envelopes') {
      const messages = { ...this.messages };
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
      this.messages = messages;
      this.onChange();
      this.cache.persist(this.room, this.keys.cacheKey, { chats: [], envelopes: fresh, cursors });
    } else if (frame.type === 'workspaces') {
      const workspaces = frame.workspaces.map((w) => ({ ...w, open: w.open ?? true }));
      this.workspaces = workspaces;
      this.onChange();
      this.cache.setWorkspaces(this.room, this.keys.cacheKey, workspaces);
    } else if (frame.type === 'result') {
      this.pending.delete(frame.ref);
      this.waiters.get(frame.ref)?.({ ok: frame.ok, error: frame.error });
    }
  }
}

class HeyLoopClient {
  private snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private links: PairingLink[] = [];
  private connections = new Map<string, PairingConnection>();
  private cache = new Cache();
  private initialized?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private listenersAttached = false;
  private storageError?: string;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  init(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        const entries = await this.loadAndMigratePairings();
        this.storageError = undefined;
        this.links = entries.map((e) => e.link);
        const rooms: string[] = [];
        for (const { link, keys } of entries) {
          rooms.push(keys.room);
          const conn = new PairingConnection(link, keys, this.cache, () => this.syncSnapshot());
          this.connections.set(keys.room, conn);
        }
        this.cache.pruneRooms(rooms);
        await Promise.all([...this.connections.values()].map((conn) => conn.activate()));
        this.syncSnapshot(true);
        this.attachGlobalListeners();
      } catch (error) {
        console.warn('pairing storage error:', error instanceof Error ? error.name : 'unknown');
        this.initialized = undefined;
        this.storageError = 'Could not access secure storage. Retry to load paired computers.';
        this.syncSnapshot(true);
        throw error;
      }
    })();
    return this.initialized;
  }

  retryInit(): Promise<void> {
    if (this.storageError) {
      this.storageError = undefined;
      this.syncSnapshot(false);
    }
    return this.init();
  }

  async pair(link: PairingLink): Promise<void> {
    await this.init();
    return this.enqueueMutation(async () => {
      const keys = deriveKeys(link.secret);
      const existingIdx = this.links.findIndex((l) => deriveKeys(l.secret).room === keys.room);
      const nextLinks =
        existingIdx >= 0
          ? this.links.map((l, idx) => (idx === existingIdx ? link : l))
          : [...this.links, link];

      await SecureStore.setItemAsync(PAIRINGS_KEY, JSON.stringify(nextLinks));
      this.links = nextLinks;

      const existing = this.connections.get(keys.room);
      if (existing) {
        existing.reconfigure(link, keys);
        this.syncSnapshot();
        await existing.activate();
      } else {
        const conn = new PairingConnection(link, keys, this.cache, () => this.syncSnapshot());
        this.connections.set(keys.room, conn);
        this.syncSnapshot();
        await conn.activate();
      }
    });
  }

  async unpair(room?: string): Promise<void> {
    await this.init();
    return this.enqueueMutation(async () => {
      const targetRoom = room ?? (this.connections.size === 1 ? this.connections.keys().next().value : undefined);
      if (!targetRoom) return;
      const nextLinks = this.links.filter((l) => deriveKeys(l.secret).room !== targetRoom);
      if (nextLinks.length > 0) {
        await SecureStore.setItemAsync(PAIRINGS_KEY, JSON.stringify(nextLinks));
      } else {
        await SecureStore.deleteItemAsync(PAIRINGS_KEY);
      }
      const conn = this.connections.get(targetRoom);
      if (conn) await conn.sendPushOff();
      this.links = nextLinks;
      conn?.destroy();
      this.connections.delete(targetRoom);
      this.cache.clear(targetRoom);
      this.syncSnapshot();
    });
  }

  toggleFavourite(room: string, chatId: string): boolean {
    const conn = this.connections.get(room);
    if (!conn) return false;
    const key = chatKey(room, chatId);
    if (!conn.chats.has(chatId) && !conn.favourites.has(key)) return false;
    const added = !conn.favourites.has(key);
    if (added) conn.favourites.add(key);
    else conn.favourites.delete(key);
    this.cache.setFavourite(conn.room, key, added);
    this.syncSnapshot();
    return added;
  }

  reconnectNow(room?: string): void {
    if (room) {
      this.connections.get(room)?.reconnectNow();
      return;
    }
    for (const conn of this.connections.values()) {
      if (conn.status !== 'online' && conn.status !== 'connecting') {
        conn.reconnectNow();
      }
    }
  }

  send(frame: OutgoingFrame, room?: string): boolean {
    const conn = this.resolveConnection(room);
    return conn ? conn.send(frame) : false;
  }

  /**
   * Sends a user action to the target machine and waits for the daemon's result. After 'unconfirmed' the frame stays
   * queued on that connection and is resent with the same id on reconnect; pass that id again to retry so the daemon dedupes it.
   */
  submit(frame: OutgoingFrame, id: string = randomUUID(), room?: string): Promise<SubmitResult> {
    const conn = this.resolveConnection(room);
    if (!conn) return Promise.resolve({ id, ok: false, error: 'offline' });
    return conn.submit(frame, id);
  }

  /** Stops resending an unconfirmed action on the connection that received it. */
  discard(id: string, room: string): void {
    this.resolveConnection(room)?.discard(id);
  }

  private resolveConnection(room?: string): PairingConnection | undefined {
    return room ? this.connections.get(room) : undefined;
  }

  private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private attachGlobalListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        // A backgrounded socket can look alive for minutes; staying disconnected lets the relay ring the phone instead.
        for (const conn of this.connections.values()) conn.onBackground();
        this.syncSnapshot();
      } else if (state === 'active') {
        for (const conn of this.connections.values()) {
          if (conn.status === 'offline') conn.reconnectNow();
        }
      }
    });
    watchPushToken((token) => {
      for (const conn of this.connections.values()) conn.registerPush(token);
    });
  }

  private async loadAndMigratePairings(): Promise<{ link: PairingLink; keys: PairingKeys }[]> {
    const [rawList, rawLegacy] = await Promise.all([
      SecureStore.getItemAsync(PAIRINGS_KEY),
      SecureStore.getItemAsync(LEGACY_PAIRING_KEY),
    ]);
    const byRoom = new Map<string, { link: PairingLink; keys: PairingKeys }>();

    if (rawList) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawList);
      } catch {
        console.warn('Ignoring malformed pairing list JSON');
      }
      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          const valid = parseStoredPairingLink(parsed[i]);
          if (valid) {
            if (!byRoom.has(valid.keys.room)) byRoom.set(valid.keys.room, valid);
          } else {
            console.warn(`Skipping corrupt pairing entry at index ${i}`);
          }
        }
      } else if (parsed !== undefined) {
        console.warn('Ignoring non-array pairing list in storage');
      }
    }

    if (rawLegacy) {
      let legacyParsed: unknown;
      try {
        legacyParsed = JSON.parse(rawLegacy);
      } catch {
        console.warn('Ignoring malformed legacy pairing JSON');
      }
      const validLegacy = legacyParsed !== undefined ? parseStoredPairingLink(legacyParsed) : undefined;
      if (validLegacy) {
        if (!byRoom.has(validLegacy.keys.room)) {
          const entries = [validLegacy, ...byRoom.values()];
          byRoom.clear();
          for (const entry of entries) byRoom.set(entry.keys.room, entry);
        }
      } else if (legacyParsed !== undefined) {
        console.warn('Skipping corrupt legacy pairing entry');
      }
      const migratedLinks = [...byRoom.values()].map((e) => e.link);
      await SecureStore.setItemAsync(PAIRINGS_KEY, JSON.stringify(migratedLinks));
      await SecureStore.deleteItemAsync(LEGACY_PAIRING_KEY);
    }

    return [...byRoom.values()];
  }

  private syncSnapshot(loaded = this.snapshot.loaded): void {
    const machines: PairedMachine[] = [];
    const chats: PairedChat[] = [];
    const messages: Record<string, Envelope[]> = {};
    const favourites = new Set<string>();

    for (const conn of this.connections.values()) {
      machines.push(conn.toMachineState());
      for (const chat of conn.chats.values()) chats.push(chat);
      for (const [chatId, envs] of Object.entries(conn.messages)) {
        messages[chatKey(conn.room, chatId)] = envs;
      }
      for (const fav of conn.favourites) favourites.add(fav);
    }

    this.snapshot = { loaded, storageError: this.storageError, machines, chats, messages, favourites };
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
