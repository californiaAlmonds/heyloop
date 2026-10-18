import type { Chat, ChatStatus, Envelope, MessageBody } from '@heyloop/protocol';
import type { Workspace } from '@heyloop/protocol/relay';

export const OTHER_WORKSPACE_ID = 'other';

export const WORKSPACE_COLORS = {
  open: '#30a46c',
  closed: '#9aa0a6',
} as const;

export const STATUS_COLORS: Record<ChatStatus, string> = {
  running: '#2f80ed',
  waiting_input: '#f2a20c',
  idle: '#9aa0a6',
  stopped: '#6b7280',
  error: '#e5484d',
};

export const STATUS_LABELS: Record<ChatStatus, string> = {
  running: 'Running',
  waiting_input: 'Waiting for you',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
};

export function chatMachine<M extends { room: string }>(
  chat: { room: string } | undefined,
  machines: readonly M[],
): M | undefined {
  return chat ? machines.find((m) => m.room === chat.room) : undefined;
}

export function chatWorkspace(
  chat: (Pick<Chat, 'workspace_id'> & { room: string }) | undefined,
  machines: readonly { room: string; workspaces: Workspace[] }[],
): Workspace | undefined {
  if (!chat?.workspace_id) return undefined;
  return chatMachine(chat, machines)?.workspaces.find((w) => w.id === chat.workspace_id);
}

export function machineName(
  chat: { room: string } | undefined,
  machines: readonly { room: string; name: string }[],
): string {
  return chatMachine(chat, machines)?.name ?? 'Computer';
}

export function chatLocationLabel(
  workspace: Pick<Workspace, 'name'> | undefined,
  machine: string | undefined,
): string {
  return [workspace?.name, machine].filter(Boolean).join(' · ');
}

export function workspaceOpenLabel(workspace: Pick<Workspace, 'open'> | undefined): 'Open' | 'Closed' {
  return workspace?.open ? 'Open' : 'Closed';
}

export function chatCountLabel(count: number): string {
  return `${count} chat${count === 1 ? '' : 's'}`;
}

export function workspaceCountLabel(count: number, openOnly = false): string {
  return `${count} ${openOnly ? 'open ' : ''}workspace${count === 1 ? '' : 's'}`;
}

export function relayHost(relay: string): string {
  try {
    return new URL(relay).host;
  } catch {
    return relay;
  }
}

export function describe(body: MessageBody): string | undefined {
  switch (body.kind) {
    case 'text':
      return body.text;
    case 'status':
      return body.summary;
    case 'approval_request':
      return body.question;
    case 'approval_response':
      return body.text ?? `Answered: ${body.option_id ?? 'ok'}`;
    case 'approval_resolved':
      return body.outcome === 'answered' ? `Answered on ${body.answered_via ?? 'unknown'}` : `Approval ${body.outcome}`;
    case 'chat_meta':
      return body.title ? `Renamed to “${body.title}”` : body.status ? `Status: ${STATUS_LABELS[body.status]}` : undefined;
    case 'presence':
      return undefined;
  }
}

/** Approval requests in this chat that haven't been resolved yet. */
export function pendingApprovals(envelopes: Envelope[]): Extract<MessageBody, { kind: 'approval_request' }>[] {
  const resolved = new Set(
    envelopes.flatMap((e) => (e.body.kind === 'approval_resolved' ? [e.body.request_id] : [])),
  );
  return envelopes.flatMap((e) =>
    e.body.kind === 'approval_request' && !resolved.has(e.body.request_id) ? [e.body] : [],
  );
}

export function lastActivity(chat: Chat, envelopes: Envelope[] | undefined): string {
  const last = envelopes?.at(-1)?.ts;
  return last && last > chat.last_heartbeat ? last : chat.last_heartbeat;
}

const ERROR_MESSAGES: Record<string, string> = {
  offline: 'Not connected to the relay.',
  unconfirmed: 'Not confirmed yet. Your computer may be offline; it will be delivered when it reconnects.',
  already_resolved: 'Already answered or expired.',
  not_found: 'Your computer no longer knows about this.',
  invalid_option: 'That option is no longer valid.',
  text_required: 'Type an answer first.',
  window_offline: 'That VS Code window closed. Pick another.',
};

export function errorMessage(code: string | undefined): string {
  return (code && ERROR_MESSAGES[code]) || 'Something went wrong. Try again.';
}

export function formatTime(ts: string): string {
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
