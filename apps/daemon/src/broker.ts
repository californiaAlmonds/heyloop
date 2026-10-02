import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import type { AnsweredVia, ApprovalResult } from '@heyloop/protocol';
import type { ApprovalRecord, ApprovalRequest, Store } from './store.js';

export type AnswerError = 'not_found' | 'already_resolved' | 'invalid_option' | 'text_required';

const EXPIRY_SWEEP_MS = 5_000;

export class ApprovalBroker {
  private events = new EventEmitter().setMaxListeners(0);

  constructor(private store: Store) {
    setInterval(() => this.expireDue(), EXPIRY_SWEEP_MS).unref();
  }

  create(
    chatId: string,
    req: Omit<ApprovalRequest, 'kind' | 'request_id' | 'expires_at'>,
    timeoutMinutes: number,
    onTimeout: string,
  ): ApprovalRequest {
    const body: ApprovalRequest = {
      kind: 'approval_request',
      ...req,
      request_id: ulid(),
      expires_at: new Date(Date.now() + timeoutMinutes * 60_000).toISOString(),
    };
    this.store.createApproval({
      request_id: body.request_id,
      chat_id: chatId,
      input: body.input,
      options: body.options ?? [],
      on_timeout: onTimeout,
      expires_at: body.expires_at,
    });
    this.store.append(chatId, 'agent', body);
    this.store.touchChat(chatId, 'waiting_input');
    return body;
  }

  answer(
    requestId: string,
    answer: { option_id?: string; text?: string },
    via: AnsweredVia,
  ): { ok: true } | { ok: false; error: AnswerError } {
    const rec = this.store.getApproval(requestId);
    if (!rec) return { ok: false, error: 'not_found' };
    if (rec.status !== 'pending') return { ok: false, error: 'already_resolved' };
    if (rec.input === 'text') {
      if (!answer.text?.trim()) return { ok: false, error: 'text_required' };
    } else if (!rec.options.some((o) => o.id === answer.option_id)) {
      return { ok: false, error: 'invalid_option' };
    }
    if (!this.store.resolveApproval(requestId, 'answered', { ...answer, answered_via: via })) {
      return { ok: false, error: 'already_resolved' };
    }
    this.store.append(rec.chat_id, 'user', { kind: 'approval_response', request_id: requestId, ...answer });
    this.finish(rec, 'answered', via);
    return { ok: true };
  }

  /** Resolves when the request is resolved, the timeout elapses, or the signal aborts. */
  wait(requestId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(requestId, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.on(requestId, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  result(rec: ApprovalRecord): ApprovalResult {
    const base = { chat_id: rec.chat_id, request_id: rec.request_id, status: rec.status };
    if (rec.status === 'pending') {
      return { ...base, next_step: `Call await_human_response with request_id "${rec.request_id}".` };
    }
    return {
      ...base,
      answer: { option_id: rec.option_id, text: rec.text, answered_at: rec.answered_at ?? new Date().toISOString() },
      answered_via: rec.answered_via,
    };
  }

  private expireDue(): void {
    for (const rec of this.store.dueApprovals()) {
      if (this.store.resolveApproval(rec.request_id, 'expired', { option_id: rec.on_timeout })) {
        this.finish(rec, 'expired');
      }
    }
  }

  private finish(rec: ApprovalRecord, outcome: 'answered' | 'expired', via?: AnsweredVia): void {
    this.store.append(rec.chat_id, 'system', {
      kind: 'approval_resolved',
      request_id: rec.request_id,
      outcome,
      answered_via: via,
    });
    const stillWaiting = this.store.listPendingApprovals().some((a) => a.chat_id === rec.chat_id);
    if (!stillWaiting) this.store.touchChat(rec.chat_id, 'running');
    this.events.emit(rec.request_id);
  }
}
