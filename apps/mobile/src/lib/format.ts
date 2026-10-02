import type { Chat, ChatStatus, Envelope, MessageBody } from '@heyloop/protocol';

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

export function formatTime(ts: string): string {
  const date = new Date(ts);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
