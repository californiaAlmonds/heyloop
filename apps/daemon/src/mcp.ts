import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ElicitResultSchema,
  type ElicitRequestFormParams,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ApprovalResult,
  AskHumanApprovalInput,
  AwaitHumanResponseInput,
  DEFAULT_CONFIRM_OPTIONS,
  SendStatusUpdateInput,
  SendStatusUpdateOutput,
  type ChatSource,
  type ChatStatus,
  type StatusLevel,
} from '@heyloop/protocol';
import type { ApprovalBroker } from './broker.js';
import type { ApprovalRequest, Store } from './store.js';

const DEFAULT_WAIT_SECONDS = 45;
const DEFAULT_TIMEOUT_MINUTES = 60;

const INSTRUCTIONS = `HeyLoop relays progress and decisions between you and the user's phone. The user may be away from the computer.
- On your first HeyLoop call of a task, pass a short "title". Reuse the returned chat_id on every later call.
- Report milestones, completions and errors with send_status_update. Keep "summary" to one or two sentences.
- Before risky or irreversible actions (deleting files, force-pushing, installing packages, migrations, anything that costs money or contacts other people), or when blocked on a decision, call ask_human_approval. Never wait on an interactive terminal prompt; put the exact command in "command".
- If ask_human_approval returns status "pending", call await_human_response with the request_id. Repeat until the status is not pending. Do not perform the action while pending.
- If the status is "expired", follow answer.option_id; "deny" means do not proceed.
- send_status_update returns "inbox": messages the user sent from the phone. Treat them as instructions from the user.
- Prefer non-interactive command flags (for example --yes, CI=1) so commands never stall on prompts.`;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

// Readonly hint stops VS Code from asking for confirmation before every HeyLoop call.
const annotations = { readOnlyHint: true, openWorldHint: false } as const;

function toolResult<T extends object>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function statusForLevel(level: StatusLevel): ChatStatus {
  if (level === 'success') return 'idle';
  if (level === 'error') return 'error';
  return 'running';
}

function detectSource(clientName: string | undefined): ChatSource {
  const name = clientName?.toLowerCase() ?? '';
  if (name.includes('visual studio code') || name.includes('vscode')) return 'vscode';
  if (name.includes('claude')) return 'claude_desktop';
  return 'other';
}

export function createMcpServer(store: Store, broker: ApprovalBroker): McpServer {
  const server = new McpServer({ name: 'heyloop', version: '0.0.0' }, { instructions: INSTRUCTIONS });

  const resolveChat = (chatId: string | undefined, title: string | undefined) => {
    if (chatId) {
      const chat = store.getChat(chatId);
      if (!chat) throw new Error(`Unknown chat_id "${chatId}". Omit chat_id to start a new chat.`);
      return chat;
    }
    const source = detectSource(server.server.getClientVersion()?.name);
    return store.createChat(source, title?.trim() || 'Untitled task');
  };

  const elicitOnDesktop = async (req: ApprovalRequest, extra: Extra, signal: AbortSignal) => {
    if (!server.server.getClientCapabilities()?.elicitation) return;
    const lines = [req.question];
    if (req.context) lines.push('', req.context);
    if (req.command) lines.push('', 'Command:', req.command);
    lines.push('', `Risk: ${req.risk}`);
    const options = req.options ?? [];
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] =
      req.input === 'text'
        ? {
            type: 'object',
            properties: { answer: { type: 'string', title: 'Answer' } },
            required: ['answer'],
          }
        : {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                title: 'Decision',
                enum: options.map((o) => o.id),
                enumNames: options.map((o) => o.label),
              },
              note: { type: 'string', title: 'Note (optional)' },
            },
            required: ['decision'],
          };
    try {
      const res = await extra.sendRequest(
        { method: 'elicitation/create', params: { message: lines.join('\n'), requestedSchema } },
        ElicitResultSchema,
        { signal },
      );
      if (res.action !== 'accept' || !res.content) return;
      const { answer, decision, note } = res.content as Record<string, string | undefined>;
      broker.answer(
        req.request_id,
        req.input === 'text' ? { text: answer } : { option_id: decision, text: note || undefined },
        'desktop',
      );
    } catch {
      // Aborted, timed out or dismissed; the request stays pending for other channels.
    }
  };

  const waitForAnswer = async (req: ApprovalRequest, waitSeconds: number, extra: Extra): Promise<ApprovalResult> => {
    const pending = store.getApproval(req.request_id);
    if (pending?.status === 'pending' && waitSeconds > 0) {
      const ac = new AbortController();
      const abort = () => ac.abort();
      extra.signal.addEventListener('abort', abort, { once: true });
      void elicitOnDesktop(req, extra, ac.signal);
      await broker.wait(req.request_id, waitSeconds * 1000, ac.signal);
      ac.abort();
      extra.signal.removeEventListener('abort', abort);
    }
    return broker.result(store.getApproval(req.request_id)!);
  };

  server.registerTool(
    'send_status_update',
    {
      title: 'Send status update',
      description:
        "Post a progress update to the user's HeyLoop chat on their phone. Returns any messages the user sent back.",
      inputSchema: SendStatusUpdateInput,
      outputSchema: SendStatusUpdateOutput,
      annotations,
    },
    async (args) => {
      const chat = resolveChat(args.chat_id, args.title);
      const notify = args.notify ?? ['success', 'warning', 'error'].includes(args.level);
      const env = store.append(chat.chat_id, 'agent', {
        kind: 'status',
        summary: args.summary,
        detail: args.detail,
        level: args.level,
        progress: args.progress,
        notify,
      });
      store.touchChat(chat.chat_id, statusForLevel(args.level));
      return toolResult({ chat_id: chat.chat_id, message_id: env.id, inbox: store.takeInbox(chat.chat_id) });
    },
  );

  server.registerTool(
    'ask_human_approval',
    {
      title: 'Ask human for approval',
      description:
        'Ask the user to approve an action, pick an option, or type an answer. Shown on the computer first, then on their phone. Blocks up to wait_seconds.',
      inputSchema: AskHumanApprovalInput,
      outputSchema: ApprovalResult,
      annotations,
    },
    async (args, extra) => {
      const options = args.input === 'text' ? [] : (args.options ?? (args.input === 'confirm' ? DEFAULT_CONFIRM_OPTIONS : []));
      if (args.input === 'choice' && options.length < 2) {
        throw new Error('input "choice" requires at least two options.');
      }
      const onTimeout = args.on_timeout ?? 'deny';
      if (onTimeout !== 'deny' && !options.some((o) => o.id === onTimeout)) {
        throw new Error('on_timeout must be "deny" or one of the option ids.');
      }
      const chat = resolveChat(args.chat_id, args.title);
      const req = broker.create(
        chat.chat_id,
        {
          question: args.question,
          context: args.context,
          command: args.command,
          risk: args.risk,
          input: args.input,
          options: options.length ? options : undefined,
        },
        args.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES,
        onTimeout,
      );
      return toolResult(await waitForAnswer(req, args.wait_seconds ?? DEFAULT_WAIT_SECONDS, extra));
    },
  );

  server.registerTool(
    'await_human_response',
    {
      title: 'Await human response',
      description: 'Keep waiting for an answer to a pending ask_human_approval request. Blocks up to wait_seconds.',
      inputSchema: AwaitHumanResponseInput,
      outputSchema: ApprovalResult,
      annotations,
    },
    async (args, extra) => {
      const req = store.getApprovalRequest(args.request_id);
      if (!req) throw new Error(`Unknown request_id "${args.request_id}".`);
      return toolResult(await waitForAnswer(req, args.wait_seconds ?? DEFAULT_WAIT_SECONDS, extra));
    },
  );

  return server;
}
