import { z } from 'zod';
import { Chat, Envelope, PresenceState } from './index.js';

// ---- Relay wire frames (plaintext to the relay; `data` is always ciphertext) ----

export const RelayRole = z.enum(['daemon', 'phone']);
export type RelayRole = z.infer<typeof RelayRole>;

export const RelayClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string().min(40).max(100) }),
  z.object({ t: z.literal('send'), data: z.string().min(1) }),
  z.object({ t: z.literal('ack'), id: z.string().min(1).max(40) }),
]);
export type RelayClientFrame = z.infer<typeof RelayClientFrame>;

export const RelayServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('msg'), id: z.string(), data: z.string() }),
  z.object({ t: z.literal('peer'), online: z.boolean() }),
]);
export type RelayServerFrame = z.infer<typeof RelayServerFrame>;

// ---- End-to-end encrypted app frames ----

export const DaemonFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chats'),
    machine: z.object({ id: z.string(), name: z.string() }),
    chats: z.array(Chat),
  }),
  z.object({ type: z.literal('envelopes'), envelopes: z.array(Envelope) }),
  z.object({ type: z.literal('result'), ref: z.string(), ok: z.boolean(), error: z.string().optional() }),
]);
export type DaemonFrame = z.infer<typeof DaemonFrame>;

export const PhoneFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sync'), id: z.string(), cursors: z.record(z.string(), z.number().int().nonnegative()) }),
  z.object({
    type: z.literal('answer'),
    id: z.string(),
    request_id: z.string(),
    option_id: z.string().optional(),
    text: z.string().max(4000).optional(),
  }),
  z.object({ type: z.literal('say'), id: z.string(), chat_id: z.string(), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('rename'), id: z.string(), chat_id: z.string(), title: z.string().min(1).max(80) }),
  z.object({ type: z.literal('presence'), id: z.string(), state: PresenceState }),
]);
export type PhoneFrame = z.infer<typeof PhoneFrame>;
