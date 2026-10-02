import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const ChatStatus = z.enum(['running', 'waiting_input', 'idle', 'stopped', 'error']);
export type ChatStatus = z.infer<typeof ChatStatus>;

export const ChatSource = z.enum(['vscode', 'claude_desktop', 'claude_sdk', 'codex', 'pty', 'other']);
export type ChatSource = z.infer<typeof ChatSource>;

export const Chat = z.object({
  chat_id: z.string(),
  machine_id: z.string(),
  source: ChatSource,
  title: z.string(),
  title_locked: z.boolean(),
  status: ChatStatus,
  last_heartbeat: z.string(),
  created_at: z.string(),
});
export type Chat = z.infer<typeof Chat>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const InputKind = z.enum(['confirm', 'choice', 'text']);
export type InputKind = z.infer<typeof InputKind>;

export const ApprovalOption = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(40),
  style: z.enum(['primary', 'danger']).optional(),
});
export type ApprovalOption = z.infer<typeof ApprovalOption>;

export const AnsweredVia = z.enum(['desktop', 'phone']);
export type AnsweredVia = z.infer<typeof AnsweredVia>;

export const StatusLevel = z.enum(['info', 'progress', 'success', 'warning', 'error']);
export type StatusLevel = z.infer<typeof StatusLevel>;

export const PresenceState = z.enum(['present', 'idle', 'locked', 'away']);
export type PresenceState = z.infer<typeof PresenceState>;

export const MessageBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('status'),
    summary: z.string(),
    detail: z.string().optional(),
    level: StatusLevel,
    progress: z.number().min(0).max(100).optional(),
    notify: z.boolean(),
  }),
  z.object({
    kind: z.literal('approval_request'),
    request_id: z.string(),
    question: z.string(),
    context: z.string().optional(),
    command: z.string().optional(),
    risk: RiskLevel,
    input: InputKind,
    options: z.array(ApprovalOption).optional(),
    expires_at: z.string(),
  }),
  z.object({
    kind: z.literal('approval_response'),
    request_id: z.string(),
    option_id: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    kind: z.literal('approval_resolved'),
    request_id: z.string(),
    outcome: z.enum(['answered', 'expired', 'cancelled']),
    answered_via: AnsweredVia.optional(),
  }),
  z.object({ kind: z.literal('chat_meta'), title: z.string().optional(), status: ChatStatus.optional() }),
  z.object({ kind: z.literal('presence'), state: PresenceState }),
]);
export type MessageBody = z.infer<typeof MessageBody>;

export const Sender = z.enum(['agent', 'user', 'system']);
export type Sender = z.infer<typeof Sender>;

export const Envelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  chat_id: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  sender: Sender,
  body: MessageBody,
});
export type Envelope = z.infer<typeof Envelope>;

// ---- MCP tool contracts ----

export const SendStatusUpdateInput = z.object({
  chat_id: z.string().optional().describe('Reuse the chat_id returned by your first HeyLoop call. Omit only for the first call of a task.'),
  title: z.string().max(80).optional().describe('Short chat title; used only when a new chat is created.'),
  summary: z.string().min(1).max(200).describe('One or two sentences shown as the phone notification.'),
  detail: z.string().max(4000).optional().describe('Longer context shown when the message is expanded.'),
  level: StatusLevel,
  progress: z.number().min(0).max(100).optional().describe('Overall progress percentage, if known.'),
  notify: z.boolean().optional().describe('Push a notification. Defaults to true for success, warning and error.'),
});
export type SendStatusUpdateInput = z.infer<typeof SendStatusUpdateInput>;

export const InboxMessage = z.object({ id: z.string(), text: z.string(), ts: z.string() });
export type InboxMessage = z.infer<typeof InboxMessage>;

export const SendStatusUpdateOutput = z.object({
  chat_id: z.string(),
  message_id: z.string(),
  inbox: z.array(InboxMessage),
});
export type SendStatusUpdateOutput = z.infer<typeof SendStatusUpdateOutput>;

export const AskHumanApprovalInput = z.object({
  chat_id: z.string().optional().describe('Reuse the chat_id returned by your first HeyLoop call.'),
  title: z.string().max(80).optional().describe('Short chat title; used only when a new chat is created.'),
  question: z.string().min(1).max(200),
  context: z.string().max(2000).optional().describe('Concise summary of why you are asking.'),
  command: z.string().max(4000).optional().describe('Exact command or diff to be approved; shown verbatim.'),
  risk: RiskLevel,
  input: InputKind,
  options: z.array(ApprovalOption).min(2).max(6).optional().describe('Required for "choice". Defaults to Approve/Reject for "confirm".'),
  timeout_minutes: z.number().int().min(1).max(720).optional().describe('Default 60.'),
  on_timeout: z.string().optional().describe('"deny" or an option id applied when the request expires. Default "deny".'),
  wait_seconds: z.number().int().min(0).max(55).optional().describe('How long this call blocks for an answer. Default 45.'),
});
export type AskHumanApprovalInput = z.infer<typeof AskHumanApprovalInput>;

export const AwaitHumanResponseInput = z.object({
  request_id: z.string(),
  wait_seconds: z.number().int().min(0).max(55).optional().describe('Default 45.'),
});
export type AwaitHumanResponseInput = z.infer<typeof AwaitHumanResponseInput>;

export const ApprovalAnswer = z.object({
  option_id: z.string().optional(),
  text: z.string().optional(),
  answered_at: z.string(),
});
export type ApprovalAnswer = z.infer<typeof ApprovalAnswer>;

export const ApprovalResult = z.object({
  chat_id: z.string(),
  request_id: z.string(),
  status: z.enum(['answered', 'pending', 'expired', 'cancelled']),
  answer: ApprovalAnswer.optional(),
  answered_via: AnsweredVia.optional(),
  next_step: z.string().optional(),
});
export type ApprovalResult = z.infer<typeof ApprovalResult>;

export const DEFAULT_CONFIRM_OPTIONS: ApprovalOption[] = [
  { id: 'approve', label: 'Approve', style: 'primary' },
  { id: 'reject', label: 'Reject', style: 'danger' },
];
