import nacl from 'tweetnacl';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function derive(secret: Uint8Array, label: string, length: number): Uint8Array {
  const label8 = encoder.encode(`heyloop:${label}:`);
  const input = new Uint8Array(label8.length + secret.length);
  input.set(label8);
  input.set(secret, label8.length);
  return nacl.hash(input).slice(0, length);
}

export interface PairingKeys {
  /** Public room id the relay routes on. */
  room: string;
  /** Shared bearer secret both sides present to the relay; never the encryption key. */
  authToken: string;
  /** XSalsa20-Poly1305 key; never leaves paired devices. */
  key: Uint8Array;
}

export function newPairingSecret(): string {
  return toBase64Url(nacl.randomBytes(32));
}

export function deriveKeys(secret: string): PairingKeys {
  const s = fromBase64Url(secret);
  if (s.length !== 32) throw new Error('Pairing secret must be 32 bytes');
  return {
    room: toBase64Url(derive(s, 'room', 16)),
    authToken: toBase64Url(derive(s, 'auth', 32)),
    key: derive(s, 'enc', nacl.secretbox.keyLength),
  };
}

export function seal(key: Uint8Array, value: unknown): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(encoder.encode(JSON.stringify(value)), nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return toBase64Url(out);
}

/** Returns undefined if the ciphertext was tampered with or uses another key. */
export function open(key: Uint8Array, data: string): unknown {
  const bytes = fromBase64Url(data);
  const nonce = bytes.subarray(0, nacl.secretbox.nonceLength);
  const plain = nacl.secretbox.open(bytes.subarray(nacl.secretbox.nonceLength), nonce, key);
  return plain ? JSON.parse(decoder.decode(plain)) : undefined;
}

export interface PairingLink {
  relay: string;
  secret: string;
  name: string;
}

export function formatPairingLink({ relay, secret, name }: PairingLink): string {
  const q = new URLSearchParams({ v: '1', r: relay, s: secret, n: name });
  return `heyloop://pair?${q.toString()}`;
}

export function parsePairingLink(link: string): PairingLink {
  const url = new URL(link);
  if (url.protocol !== 'heyloop:' || url.searchParams.get('v') !== '1') throw new Error('Not a HeyLoop pairing link');
  const relay = url.searchParams.get('r');
  const secret = url.searchParams.get('s');
  if (!relay || !secret) throw new Error('Pairing link is missing fields');
  return { relay, secret, name: url.searchParams.get('n') ?? 'Computer' };
}
