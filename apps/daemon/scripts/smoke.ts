// End-to-end check against a running daemon: npm run smoke -w @heyloop/daemon
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };

const client = new Client({ name: 'heyloop-smoke', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const status = await call('send_status_update', { title: 'Smoke test', summary: 'Starting smoke test', level: 'info' });
console.log('status:', status);

await fetch(`${base}/api/chats/${status.chat_id}/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'hello from the phone' }),
});
const status2 = await call('send_status_update', { chat_id: status.chat_id, summary: 'Checking inbox', level: 'progress' });
console.log('inbox:', status2.inbox);

const ask = await call('ask_human_approval', {
  chat_id: status.chat_id,
  question: 'Delete build folder?',
  command: 'rm -rf dist',
  risk: 'medium',
  input: 'confirm',
  wait_seconds: 1,
});
console.log('ask:', ask.status, ask.next_step);

setTimeout(() => {
  void fetch(`${base}/api/approvals/${ask.request_id}/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ option_id: 'approve', via: 'phone' }),
  });
}, 500);
const awaited = await call('await_human_response', { request_id: ask.request_id, wait_seconds: 5 });
console.log('awaited:', awaited.status, awaited.answer?.option_id, awaited.answered_via);

const late = await fetch(`${base}/api/approvals/${ask.request_id}/answer`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ option_id: 'reject' }),
});
console.log('late answer:', late.status, await late.json());

await client.close();
