import { Chat, Envelope } from '@heyloop/protocol';
import { open, seal } from '@heyloop/protocol/crypto';
import { Workspace } from '@heyloop/protocol/relay';
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'heyloop-cache.db';
// Decrypting is pure JS, so only the newest rows per chat are restored; the cursor covers the rest.
const WINDOW = 300;

const TABLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  room TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (room, chat_id)
);
CREATE TABLE IF NOT EXISTS workspaces (
  room TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (room, workspace_id)
);
CREATE TABLE IF NOT EXISTS envelopes (
  room TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (room, chat_id, seq)
);
CREATE TABLE IF NOT EXISTS cursors (
  room TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room, chat_id)
);
CREATE TABLE IF NOT EXISTS favourites (
  room TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  PRIMARY KEY (room, chat_id)
);
`;

export interface Cached {
  chats: Chat[];
  workspaces: Workspace[];
  messages: Record<string, Envelope[]>;
  cursors: Record<string, number>;
  favourites: string[];
}

export interface CacheWrite {
  chats: Chat[];
  envelopes: Envelope[];
  cursors: Record<string, number>;
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function unseal<T>(schema: Schema<T>, key: Uint8Array, data: string): T | undefined {
  try {
    const parsed = schema.safeParse(open(key, data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Encrypted-at-rest copy of the synced history, scoped per pairing room.
 * All work runs on one queue, and per-room `epochs` drop jobs queued for a pairing that has been replaced or unpaired.
 */
export class Cache {
  private db?: Promise<SQLite.SQLiteDatabase>;
  private chain: Promise<unknown> = Promise.resolve();
  private epochs = new Map<string, number>();
  private knownRooms?: string[];

  /** Attaches to a pairing room and returns its cached rows. */
  attach(room: string, key: Uint8Array): Promise<Cached | undefined> {
    const epoch = (this.epochs.get(room) ?? 0) + 1;
    this.epochs.set(room, epoch);
    return this.enqueue({ room, epoch }, (db) => this.load(db, room, key));
  }

  persist(room: string, key: Uint8Array, write: CacheWrite): void {
    const epoch = this.epochs.get(room);
    if (epoch === undefined) return;
    void this.enqueue({ room, epoch }, async (db) => {
      await db.withTransactionAsync(async () => {
        for (const chat of write.chats) {
          await db.runAsync(
            'INSERT OR REPLACE INTO chats (room, chat_id, data) VALUES (?, ?, ?)',
            room,
            chat.chat_id,
            seal(key, chat),
          );
        }
        // Envelopes are append-only, matching the in-memory dedupe by seq.
        for (const env of write.envelopes) {
          await db.runAsync(
            'INSERT OR IGNORE INTO envelopes (room, chat_id, seq, data) VALUES (?, ?, ?, ?)',
            room,
            env.chat_id,
            env.seq,
            seal(key, env),
          );
        }
        for (const [chatId, seq] of Object.entries(write.cursors)) {
          await db.runAsync('INSERT OR REPLACE INTO cursors (room, chat_id, seq) VALUES (?, ?, ?)', room, chatId, seq);
        }
      });
    });
  }

  setWorkspaces(room: string, key: Uint8Array, workspaces: Workspace[]): void {
    const epoch = this.epochs.get(room);
    if (epoch === undefined) return;
    void this.enqueue({ room, epoch }, async (db) => {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM workspaces WHERE room = ?', room);
        for (const ws of workspaces) {
          await db.runAsync(
            'INSERT OR REPLACE INTO workspaces (room, workspace_id, data) VALUES (?, ?, ?)',
            room,
            ws.id,
            seal(key, ws),
          );
        }
      });
    });
  }

  setFavourite(room: string, chatId: string, favourite: boolean): void {
    const epoch = this.epochs.get(room);
    if (epoch === undefined) return;
    void this.enqueue({ room, epoch }, async (db) => {
      if (favourite) {
        await db.runAsync('INSERT OR IGNORE INTO favourites (room, chat_id) VALUES (?, ?)', room, chatId);
      } else {
        await db.runAsync('DELETE FROM favourites WHERE room = ? AND chat_id = ?', room, chatId);
      }
    });
  }

  /** Removes cached data for one room and invalidates its queued writes (unpair). */
  clear(room: string): void {
    const next = (this.epochs.get(room) ?? 0) + 1;
    this.epochs.set(room, next);
    void this.enqueue(null, async (db) => {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM chats WHERE room = ?', room);
        await db.runAsync('DELETE FROM workspaces WHERE room = ?', room);
        await db.runAsync('DELETE FROM envelopes WHERE room = ?', room);
        await db.runAsync('DELETE FROM cursors WHERE room = ?', room);
        await db.runAsync('DELETE FROM favourites WHERE room = ?', room);
      });
    });
  }

  /** Wipes cached rows belonging to rooms that are no longer paired. */
  pruneRooms(rooms: string[]): void {
    this.knownRooms = [...rooms];
    void this.enqueue(null, async (db) => {
      await db.withTransactionAsync(async () => {
        if (rooms.length === 0) {
          await db.execAsync(
            'DELETE FROM chats; DELETE FROM workspaces; DELETE FROM envelopes; DELETE FROM cursors; DELETE FROM favourites;',
          );
          return;
        }
        const placeholders = rooms.map(() => '?').join(', ');
        for (const table of ['chats', 'workspaces', 'envelopes', 'cursors', 'favourites']) {
          await db.runAsync(`DELETE FROM ${table} WHERE room NOT IN (${placeholders})`, ...rooms);
        }
      });
    });
  }

  private async load(db: SQLite.SQLiteDatabase, room: string, key: Uint8Array): Promise<Cached> {
    const chatRows = await db.getAllAsync<{ data: string }>('SELECT data FROM chats WHERE room = ?', room);
    const chats = chatRows.flatMap((r) => unseal(Chat, key, r.data) ?? []);

    const wsRows = await db.getAllAsync<{ data: string }>('SELECT data FROM workspaces WHERE room = ?', room);
    const workspaces = wsRows.flatMap((r) => {
      const ws = unseal(Workspace, key, r.data);
      return ws ? [{ ...ws, open: false }] : [];
    });

    const envRows = await db.getAllAsync<{ data: string }>(
      `SELECT data FROM (
         SELECT chat_id, seq, data, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY seq DESC) AS n
         FROM envelopes
         WHERE room = ?
       ) WHERE n <= ? ORDER BY chat_id, seq`,
      room,
      WINDOW,
    );
    const messages: Record<string, Envelope[]> = {};
    for (const row of envRows) {
      const env = unseal(Envelope, key, row.data);
      if (env) (messages[env.chat_id] ??= []).push(env);
    }

    const cursors: Record<string, number> = {};
    const cursorRows = await db.getAllAsync<{ chat_id: string; seq: number }>(
      'SELECT chat_id, seq FROM cursors WHERE room = ?',
      room,
    );
    for (const { chat_id, seq } of cursorRows) {
      // An undecryptable row inside the window must be refetched, so stop the cursor before the gap.
      const seqs = new Set((messages[chat_id] ?? []).map((e) => e.seq));
      let reach = seqs.size ? Math.min(...seqs) : 0;
      while (seqs.has(reach + 1)) reach++;
      cursors[chat_id] = Math.min(seq, reach);
    }

    const favRows = await db.getAllAsync<{ chat_id: string }>('SELECT chat_id FROM favourites WHERE room = ?', room);
    const favourites = favRows.map((r) => r.chat_id);
    return { chats, workspaces, messages, cursors, favourites };
  }

  private database(): Promise<SQLite.SQLiteDatabase> {
    this.db ??= SQLite.openDatabaseAsync(DB_NAME)
      .then(async (db) => {
        await db.execAsync('PRAGMA journal_mode = WAL;');
        const tables = ['chats', 'workspaces', 'envelopes', 'cursors', 'favourites'] as const;
        let legacy = false;
        for (const table of tables) {
          const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
          if (cols.length > 0 && !cols.some((c) => c.name === 'room')) {
            legacy = true;
            break;
          }
        }
        if (legacy) {
          const favCols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(favourites)');
          const legacyFavs =
            favCols.length > 0 && !favCols.some((c) => c.name === 'room') && favCols.some((c) => c.name === 'chat_id')
              ? await db.getAllAsync<{ chat_id: string }>('SELECT chat_id FROM favourites')
              : [];
          await db.execAsync(`
            DROP TABLE IF EXISTS meta;
            DROP TABLE IF EXISTS chats;
            DROP TABLE IF EXISTS workspaces;
            DROP TABLE IF EXISTS envelopes;
            DROP TABLE IF EXISTS cursors;
            DROP TABLE IF EXISTS favourites;
          `);
          await db.execAsync(TABLES_SCHEMA);
          const rooms = this.knownRooms ?? [...this.epochs.keys()];
          if (rooms.length === 1) {
            const [room] = rooms;
            for (const { chat_id } of legacyFavs) {
              if (chat_id && !chat_id.includes(':')) {
                await db.runAsync(
                  'INSERT OR IGNORE INTO favourites (room, chat_id) VALUES (?, ?)',
                  room,
                  `${room}:${chat_id}`,
                );
              }
            }
          }
        } else {
          await db.execAsync(TABLES_SCHEMA);
        }
        return db;
      })
      .catch((error) => {
        this.db = undefined;
        throw error;
      });
    return this.db;
  }

  private enqueue<T>(
    guard: { room: string; epoch: number } | null,
    job: (db: SQLite.SQLiteDatabase) => Promise<T>,
  ): Promise<T | undefined> {
    const run = this.chain.then(async () => {
      if (guard !== null && this.epochs.get(guard.room) !== guard.epoch) return undefined;
      return job(await this.database());
    });
    this.chain = run.catch((error) => {
      // Error class only; messages could echo row contents.
      console.warn('cache error:', error instanceof Error ? error.name : 'unknown');
    });
    return run.catch(() => undefined);
  }
}
