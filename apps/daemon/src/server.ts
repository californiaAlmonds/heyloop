import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AnsweredVia } from '@heyloop/protocol';
import { ApprovalBroker } from './broker.js';
import { dataDir, type Config } from './config.js';
import { createMcpServer } from './mcp.js';
import { Store } from './store.js';

const MAX_BODY_BYTES = 1_000_000;

const AnswerBody = z.object({
  option_id: z.string().optional(),
  text: z.string().max(4000).optional(),
  via: AnsweredVia.default('desktop'),
});
const SayBody = z.object({ text: z.string().min(1).max(4000) });
const RenameBody = z.object({ title: z.string().min(1).max(80) });

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function startDaemon(config: Config): Server {
  const store = new Store(dataDir(), config.machine_id);
  const broker = new ApprovalBroker(store);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Host allowlist blocks DNS-rebinding attacks from web pages.
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!transport) {
        if (sessionId) throw new HttpError(404, 'Session not found');
        if (!isInitializeRequest(body)) throw new HttpError(400, 'Expected an initialize request');
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => void transports.set(id, created),
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await createMcpServer(store, broker).connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (!transport) throw new HttpError(404, 'Session not found');
    await transport.handleRequest(req, res);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const [resource, id, sub] = parts;

    if (resource === 'chats' && !id && req.method === 'GET') {
      return send(res, 200, store.listChats());
    }
    if (resource === 'chats' && id) {
      if (!store.getChat(id)) throw new HttpError(404, 'Chat not found');
      if (!sub && req.method === 'PATCH') {
        const { title } = parse(RenameBody, await readJson(req));
        store.renameChat(id, title, true);
        store.append(id, 'user', { kind: 'chat_meta', title });
        return send(res, 200, store.getChat(id));
      }
      if (sub === 'messages' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return send(res, 200, store.messagesSince(id, Number.isFinite(after) ? after : 0));
      }
      if (sub === 'messages' && req.method === 'POST') {
        const { text } = parse(SayBody, await readJson(req));
        return send(res, 201, store.append(id, 'user', { kind: 'text', text }));
      }
    }
    if (resource === 'approvals' && !id && req.method === 'GET') {
      const pending = store.listPendingApprovals().map((a) => ({ ...a, request: store.getApprovalRequest(a.request_id) }));
      return send(res, 200, pending);
    }
    if (resource === 'approvals' && id && sub === 'answer' && req.method === 'POST') {
      const { via, ...answer } = parse(AnswerBody, await readJson(req));
      const result = broker.answer(id, answer, via);
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : result.error === 'already_resolved' ? 409 : 400;
        throw new HttpError(status, result.error);
      }
      return send(res, 200, broker.result(store.getApproval(id)!));
    }
    throw new HttpError(404, 'Not found');
  };

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Forbidden host');
      if (!isAuthorized(req, config.token)) throw new HttpError(401, 'Unauthorized');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  });

  server.listen(config.port, '127.0.0.1');
  return server;
}
