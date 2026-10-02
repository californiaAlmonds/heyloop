import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import {
  PROTOCOL_VERSION,
  type AnsweredVia,
  type ApprovalOption,
  type Chat,
  type ChatSource,
  type ChatStatus,
  type Envelope,
  type InboxMessage,
  type InputKind,
  type MessageBody,
  type Sender,
} from '@heyloop/protocol';

export type ApprovalStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export type ApprovalRequest = Extract<MessageBody, { kind: 'approval_request' }>;

export interface ApprovalRecord {
  request_id: string;
  chat_id: string;
  status: ApprovalStatus;
  input: InputKind;
  options: ApprovalOption[];
  on_timeout: string;
  expires_at: string;
  option_id?: string;
  text?: string;
  answered_via?: AnsweredVia;
  answered_at?: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  title_locked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(chat_id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (chat_id, seq)
);
CREATE TABLE IF NOT EXISTS approvals (
  request_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(chat_id),
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  options TEXT NOT NULL,
  on_timeout TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  option_id TEXT,
  text TEXT,
  answered_via TEXT,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (status, expires_at);
CREATE TABLE IF NOT EXISTS inbound_frames (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
const opt = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));

function toChat(r: Row): Chat {
  return {
    chat_id: r.chat_id as string,
    machine_id: r.machine_id as string,
    source: r.source as ChatSource,
    title: r.title as string,
    title_locked: r.title_locked === 1,
    status: r.status as ChatStatus,
    last_heartbeat: r.last_heartbeat as string,
    created_at: r.created_at as string,
  };
}

function toApproval(r: Row): ApprovalRecord {
  return {
    request_id: r.request_id as string,
    chat_id: r.chat_id as string,
    status: r.status as ApprovalStatus,
    input: r.input as InputKind,
    options: JSON.parse(r.options as string) as ApprovalOption[],
    on_timeout: r.on_timeout as string,
    expires_at: r.expires_at as string,
    option_id: opt(r.option_id),
    text: opt(r.text),
    answered_via: opt(r.answered_via),
    answered_at: opt(r.answered_at),
  };
}

export class Store extends EventEmitter<{ envelope: [Envelope]; chat: [Chat] }> {
  private db: DatabaseSync;

  constructor(dir: string, private machineId: string) {
    super();
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'heyloop.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  createChat(source: ChatSource, title: string): Chat {
    const ts = now();
    const chat: Chat = {
      chat_id: ulid(),
      machine_id: this.machineId,
      source,
      title,
      title_locked: false,
      status: 'running',
      last_heartbeat: ts,
      created_at: ts,
    };
    this.db
      .prepare('INSERT INTO chats VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(chat.chat_id, chat.machine_id, chat.source, chat.title, chat.status, ts, ts);
    this.emit('chat', chat);
    return chat;
  }

  getChat(chatId: string): Chat | undefined {
    const row = this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as Row | undefined;
    return row ? toChat(row) : undefined;
  }

  listChats(): Chat[] {
    return (this.db.prepare('SELECT * FROM chats ORDER BY last_heartbeat DESC').all() as Row[]).map(toChat);
  }

  touchChat(chatId: string, status?: ChatStatus): void {
    if (status) {
      this.db.prepare('UPDATE chats SET status = ?, last_heartbeat = ? WHERE chat_id = ?').run(status, now(), chatId);
    } else {
      this.db.prepare('UPDATE chats SET last_heartbeat = ? WHERE chat_id = ?').run(now(), chatId);
    }
    this.emitChat(chatId);
  }

  renameChat(chatId: string, title: string, byUser: boolean): boolean {
    const sql = byUser
      ? 'UPDATE chats SET title = ?, title_locked = 1 WHERE chat_id = ?'
      : 'UPDATE chats SET title = ? WHERE chat_id = ? AND title_locked = 0';
    const changed = this.db.prepare(sql).run(title, chatId).changes === 1;
    if (changed) this.emitChat(chatId);
    return changed;
  }

  private emitChat(chatId: string): void {
    const chat = this.getChat(chatId);
    if (chat) this.emit('chat', chat);
  }

  append(chatId: string, sender: Sender, body: MessageBody): Envelope {
    const { seq } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?')
      .get(chatId) as { seq: number };
    const env: Envelope = { v: PROTOCOL_VERSION, id: ulid(), chat_id: chatId, seq, ts: now(), sender, body };
    this.db
      .prepare('INSERT INTO messages (id, chat_id, seq, ts, sender, kind, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(env.id, chatId, seq, env.ts, sender, body.kind, JSON.stringify(body));
    this.emit('envelope', env);
    return env;
  }

  messagesSince(chatId: string, afterSeq: number): Envelope[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq')
      .all(chatId, afterSeq) as Row[];
    return rows.map((r) => ({
      v: PROTOCOL_VERSION,
      id: r.id as string,
      chat_id: r.chat_id as string,
      seq: r.seq as number,
      ts: r.ts as string,
      sender: r.sender as Sender,
      body: JSON.parse(r.body as string) as MessageBody,
    }));
  }

  /** Returns unread user text messages for a chat and marks them consumed. */
  takeInbox(chatId: string): InboxMessage[] {
    const rows = this.db
      .prepare(
        "SELECT id, ts, body FROM messages WHERE chat_id = ? AND sender = 'user' AND kind = 'text' AND consumed = 0 ORDER BY seq",
      )
      .all(chatId) as Row[];
    const mark = this.db.prepare('UPDATE messages SET consumed = 1 WHERE id = ?');
    return rows.map((r) => {
      mark.run(r.id as string);
      return { id: r.id as string, ts: r.ts as string, text: (JSON.parse(r.body as string) as { text: string }).text };
    });
  }

  /** Records an inbound frame id; returns false if it was already processed. */
  markProcessed(frameId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO inbound_frames VALUES (?, ?)').run(frameId, now()).changes === 1;
  }

  createApproval(rec: Omit<ApprovalRecord, 'status'>): ApprovalRecord {
    this.db
      .prepare(
        "INSERT INTO approvals (request_id, chat_id, status, input, options, on_timeout, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
      )
      .run(rec.request_id, rec.chat_id, rec.input, JSON.stringify(rec.options), rec.on_timeout, rec.expires_at);
    return { ...rec, status: 'pending' };
  }

  getApproval(requestId: string): ApprovalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE request_id = ?').get(requestId) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  getApprovalRequest(requestId: string): ApprovalRequest | undefined {
    const row = this.db
      .prepare("SELECT body FROM messages WHERE kind = 'approval_request' AND json_extract(body, '$.request_id') = ?")
      .get(requestId) as Row | undefined;
    return row ? (JSON.parse(row.body as string) as ApprovalRequest) : undefined;
  }

  listPendingApprovals(): ApprovalRecord[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY expires_at").all() as Row[]).map(
      toApproval,
    );
  }

  dueApprovals(): ApprovalRecord[] {
    return (
      this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?").all(now()) as Row[]
    ).map(toApproval);
  }

  /** Compare-and-set from pending; returns false if another answer already won. */
  resolveApproval(
    requestId: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    answer: { option_id?: string; text?: string; answered_via?: AnsweredVia },
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE approvals SET status = ?, option_id = ?, text = ?, answered_via = ?, answered_at = ? WHERE request_id = ? AND status = 'pending'",
        )
        .run(status, answer.option_id ?? null, answer.text ?? null, answer.answered_via ?? null, now(), requestId)
        .changes === 1
    );
  }
}
