import { Chat, Envelope } from '@heyloop/protocol';
import { open, seal } from '@heyloop/protocol/crypto';
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'heyloop-cache.db';
// Decrypting is pure JS, so only the newest rows per chat are restored; the cursor covers the rest.
const WINDOW = 300;

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS envelopes (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
CREATE TABLE IF NOT EXISTS cursors (chat_id TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL);
`;

export interface Cached {
  chats: Chat[];
  messages: Record<string, Envelope[]>;
  cursors: Record<string, number>;
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
 * Encrypted-at-rest copy of the synced history. All work runs on one queue, and `epoch` drops jobs
 * queued for a pairing that has since been replaced or removed.
 */
export class Cache {
  private db?: Promise<SQLite.SQLiteDatabase>;
  private chain: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private session?: { room: string; key: Uint8Array };

  /** Binds to a pairing, wipes data left by any other pairing, and returns what was stored. */
  attach(room: string, key: Uint8Array): Promise<Cached | undefined> {
    const epoch = ++this.epoch;
    this.session = { room, key };
    return this.enqueue(epoch, async (db) => {
      const stored = await db.getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'room');
      if (stored?.v !== room) {
        await db.withTransactionAsync(async () => {
          await db.execAsync('DELETE FROM chats; DELETE FROM envelopes; DELETE FROM cursors; DELETE FROM meta;');
          await db.runAsync('INSERT INTO meta (k, v) VALUES (?, ?)', 'room', room);
        });
        return { chats: [], messages: {}, cursors: {} };
      }
      return this.load(db, key);
    });
  }

  persist(write: CacheWrite): void {
    const { session, epoch } = this;
    if (!session) return;
    void this.enqueue(epoch, async (db) => {
      await db.withTransactionAsync(async () => {
        for (const chat of write.chats) {
          await db.runAsync('INSERT OR REPLACE INTO chats (chat_id, data) VALUES (?, ?)', chat.chat_id, seal(session.key, chat));
        }
        // Envelopes are append-only, matching the in-memory dedupe by seq.
        for (const env of write.envelopes) {
          await db.runAsync(
            'INSERT OR IGNORE INTO envelopes (chat_id, seq, data) VALUES (?, ?, ?)',
            env.chat_id,
            env.seq,
            seal(session.key, env),
          );
        }
        for (const [chatId, seq] of Object.entries(write.cursors)) {
          await db.runAsync('INSERT OR REPLACE INTO cursors (chat_id, seq) VALUES (?, ?)', chatId, seq);
        }
      });
    });
  }

  /** Removes everything and invalidates queued writes (unpair). */
  clear(): void {
    this.epoch++;
    this.session = undefined;
    void this.enqueue(null, async (db) => {
      await db.execAsync('DELETE FROM chats; DELETE FROM envelopes; DELETE FROM cursors; DELETE FROM meta;');
    });
  }

  private async load(db: SQLite.SQLiteDatabase, key: Uint8Array): Promise<Cached> {
    const chatRows = await db.getAllAsync<{ data: string }>('SELECT data FROM chats');
    const chats = chatRows.flatMap((r) => unseal(Chat, key, r.data) ?? []);

    const envRows = await db.getAllAsync<{ data: string }>(
      `SELECT data FROM (
         SELECT chat_id, seq, data, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY seq DESC) AS n FROM envelopes
       ) WHERE n <= ? ORDER BY chat_id, seq`,
      WINDOW,
    );
    const messages: Record<string, Envelope[]> = {};
    for (const row of envRows) {
      const env = unseal(Envelope, key, row.data);
      if (env) (messages[env.chat_id] ??= []).push(env);
    }

    const cursors: Record<string, number> = {};
    const cursorRows = await db.getAllAsync<{ chat_id: string; seq: number }>('SELECT chat_id, seq FROM cursors');
    for (const { chat_id, seq } of cursorRows) {
      // An undecryptable row inside the window must be refetched, so stop the cursor before the gap.
      const seqs = new Set((messages[chat_id] ?? []).map((e) => e.seq));
      let reach = seqs.size ? Math.min(...seqs) : 0;
      while (seqs.has(reach + 1)) reach++;
      cursors[chat_id] = Math.min(seq, reach);
    }
    return { chats, messages, cursors };
  }

  private database(): Promise<SQLite.SQLiteDatabase> {
    this.db ??= SQLite.openDatabaseAsync(DB_NAME)
      .then(async (db) => {
        await db.execAsync(SCHEMA);
        return db;
      })
      .catch((error) => {
        this.db = undefined;
        throw error;
      });
    return this.db;
  }

  private enqueue<T>(epoch: number | null, job: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T | undefined> {
    const run = this.chain.then(async () => {
      if (epoch !== null && epoch !== this.epoch) return undefined;
      return job(await this.database());
    });
    this.chain = run.catch((error) => {
      // Error class only; messages could echo row contents.
      console.warn('cache error:', error instanceof Error ? error.name : 'unknown');
    });
    return run.catch(() => undefined);
  }
}
