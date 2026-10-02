// End-to-end check against a running daemon: npm run smoke -w @heyloop/daemon
import assert from 'node:assert/strict';
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
assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['ask_human_approval', 'await_human_response', 'send_status_update']);

const status = await call('send_status_update', { title: 'Smoke test', summary: 'Starting smoke test', level: 'info' });
console.log('status:', status);

await fetch(`${base}/api/chats/${status.chat_id}/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: 'hello from the phone' }),
});
const status2 = await call('send_status_update', { chat_id: status.chat_id, summary: 'Checking inbox', level: 'progress' });
console.log('inbox:', status2.inbox);
assert.equal(status2.inbox.length, 1);
assert.equal(status2.inbox[0].text, 'hello from the phone');

const ask = await call('ask_human_approval', {
  chat_id: status.chat_id,
  question: 'Delete build folder?',
  command: 'rm -rf dist',
  risk: 'medium',
  input: 'confirm',
  wait_seconds: 1,
});
console.log('ask:', ask.status, ask.next_step);
assert.equal(ask.status, 'pending');

setTimeout(() => {
  void fetch(`${base}/api/approvals/${ask.request_id}/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ option_id: 'approve', via: 'phone' }),
  });
}, 500);
const awaited = await call('await_human_response', { request_id: ask.request_id, wait_seconds: 5 });
console.log('awaited:', awaited.status, awaited.answer?.option_id, awaited.answered_via);
assert.equal(awaited.status, 'answered');
assert.equal(awaited.answer?.option_id, 'approve');
assert.equal(awaited.answered_via, 'phone');

const late = await fetch(`${base}/api/approvals/${ask.request_id}/answer`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ option_id: 'reject' }),
});
console.log('late answer:', late.status, await late.json());
assert.equal(late.status, 409);

await client.close();
