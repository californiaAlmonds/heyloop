import { DurableObject } from 'cloudflare:workers';
import { RelayClientFrame, type PushHint, type RelayRole, type RelayServerFrame } from '@heyloop/protocol/relay';
import { sendDoorbell } from './fcm.js';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** Firebase service-account JSON (Wrangler secret). Unset disables push. */
  FCM_SERVICE_ACCOUNT?: string;
}

interface Attachment {
  role: RelayRole;
  authed: boolean;
  since: number;
}

const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{22})\/ws$/;
const MAX_FRAME_CHARS = 512 * 1024;
const MAX_QUEUE = 2000;
// Clients ping every 30s; sleeping laptops and dozing phones vanish without a close frame.
const STALE_MS = 75_000;
const SWEEP_MS = 30_000;
const PUSH_MIN_MS = 15_000;

const other = (role: RelayRole): RelayRole => (role === 'daemon' ? 'phone' : 'daemon');
const queueKey = (role: RelayRole, id: string) => `q:${role}:${id}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function send(ws: WebSocket, frame: RelayServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket already closing; the queue still holds undelivered messages.
  }
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    const match = ROOM_PATH.exec(url.pathname);
    if (!match?.[1]) return new Response('Not found', { status: 404 });
    const role = url.searchParams.get('role');
    if (role !== 'daemon' && role !== 'phone') return new Response('Invalid role', { status: 400 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    return env.ROOM.get(env.ROOM.idFromName(match[1])).fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** One room per pairing. Forwards ciphertext between daemon and phone and queues it while a side is offline. */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('role') as RelayRole;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, authed: false, since: Date.now() } satisfies Attachment);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME_CHARS) return ws.close(1009, 'Frame too large');
    let frame: RelayClientFrame;
    try {
      frame = RelayClientFrame.parse(JSON.parse(raw));
    } catch {
      return ws.close(1003, 'Bad frame');
    }

    const att = ws.deserializeAttachment() as Attachment;
    if (!att.authed) {
      if (frame.t !== 'auth' || !(await this.authorize(att.role, frame.token))) return ws.close(4401, 'Unauthorized');
      ws.serializeAttachment({ ...att, authed: true } satisfies Attachment);
      send(ws, { t: 'ready' });
      send(ws, { t: 'peer', online: this.isOnline(other(att.role)) });
      this.broadcast(other(att.role), { t: 'peer', online: true });
      await this.drain(ws, att.role);
      return;
    }

    if (frame.t === 'push') {
      if (att.role !== 'phone') return ws.close(1008, 'Phone only');
      await this.ctx.storage.put('push:token', frame.token);
    } else if (frame.t === 'send') {
      await this.enqueue(other(att.role), frame.data);
      if (att.role === 'daemon' && frame.push && !this.isOnline('phone')) this.ctx.waitUntil(this.notify(frame.push));
    } else if (frame.t === 'ack') await this.ack(att.role, frame.id);
  }

  /** Content-free doorbell; storage (not memory) holds the rate limit because the object can be evicted. */
  private async notify(hint: PushHint): Promise<void> {
    const account = this.env.FCM_SERVICE_ACCOUNT;
    if (!account) return;
    const storage = this.ctx.storage;
    const token = await storage.get<string>('push:token');
    if (!token) return;
    const key = `push:last:${hint}`;
    const now = Date.now();
    if (now - ((await storage.get<number>(key)) ?? 0) < PUSH_MIN_MS) return;
    await storage.put(key, now);
    if ((await sendDoorbell(account, token, hint)) === 'unregistered') await storage.delete('push:token');
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.disconnected(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.disconnected(ws);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const dropped = new Set<RelayRole>();
    for (const ws of this.ctx.getWebSockets()) {
      if (this.isFresh(ws, now)) continue;
      const att = ws.deserializeAttachment() as Attachment;
      if (att.authed) dropped.add(att.role);
      try {
        ws.close(1001, 'Idle');
      } catch {
        // Already closed.
      }
    }
    for (const role of dropped) if (!this.isOnline(role)) this.broadcast(other(role), { t: 'peer', online: false });
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  private disconnected(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment;
    if (att.authed && !this.isOnline(att.role, ws)) this.broadcast(other(att.role), { t: 'peer', online: false });
  }

  private isFresh(ws: WebSocket, now = Date.now()): boolean {
    const att = ws.deserializeAttachment() as Attachment;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return now - Math.max(att.since, pinged) < STALE_MS;
  }

  /** First daemon to connect claims the room (trust on first use); everyone else must match. */
  private async authorize(role: RelayRole, token: string): Promise<boolean> {
    const hash = await sha256Hex(token);
    const stored = await this.ctx.storage.get<string>('auth');
    if (stored) return stored === hash;
    if (role !== 'daemon') return false;
    await this.ctx.storage.put('auth', hash);
    return true;
  }

  private sockets(role: RelayRole, except?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets(role)
      .filter((s) => s !== except && (s.deserializeAttachment() as Attachment).authed && this.isFresh(s));
  }

  private isOnline(role: RelayRole, except?: WebSocket): boolean {
    return this.sockets(role, except).length > 0;
  }

  private broadcast(role: RelayRole, frame: RelayServerFrame): void {
    for (const s of this.sockets(role)) send(s, frame);
  }

  private async enqueue(role: RelayRole, data: string): Promise<void> {
    const storage = this.ctx.storage;
    const counter = ((await storage.get<number>('ctr')) ?? 0) + 1;
    const id = counter.toString().padStart(12, '0');
    const size = ((await storage.get<number>(`n:${role}`)) ?? 0) + 1;
    await storage.put({ ctr: counter, [`n:${role}`]: size, [queueKey(role, id)]: data });
    this.broadcast(role, { t: 'msg', id, data });

    if (size > MAX_QUEUE) {
      const oldest = await storage.list({ prefix: `q:${role}:`, limit: size - MAX_QUEUE });
      await storage.delete([...oldest.keys()]);
      await storage.put(`n:${role}`, size - oldest.size);
    }
  }

  private async ack(role: RelayRole, id: string): Promise<void> {
    if (await this.ctx.storage.delete(queueKey(role, id))) {
      const size = (await this.ctx.storage.get<number>(`n:${role}`)) ?? 1;
      await this.ctx.storage.put(`n:${role}`, Math.max(0, size - 1));
    }
  }

  private async drain(ws: WebSocket, role: RelayRole): Promise<void> {
    const queued = await this.ctx.storage.list<string>({ prefix: `q:${role}:` });
    for (const [key, data] of queued) send(ws, { t: 'msg', id: key.slice(`q:${role}:`.length), data });
  }
}
