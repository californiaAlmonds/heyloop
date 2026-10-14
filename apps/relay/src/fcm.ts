import type { PushHint } from '@heyloop/protocol/relay';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const TEXT: Record<PushHint, { title: string; body: string; channel: string }> = {
  approval: { title: 'HeyLoop', body: 'An agent needs your approval', channel: 'approvals' },
  update: { title: 'HeyLoop', body: 'New update from your agent', channel: 'updates' },
};

let cached: { token: string; expires: number } | undefined;

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseAccount(raw: string): ServiceAccount | undefined {
  try {
    const sa = JSON.parse(raw) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key && sa.project_id ? (sa as ServiceAccount) : undefined;
  } catch {
    return undefined;
  }
}

async function signJwt(sa: ServiceAccount): Promise<string> {
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(
    encoder.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(new Uint8Array(sig))}`;
}

async function accessToken(sa: ServiceAccount): Promise<string | undefined> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await signJwt(sa),
    }),
  });
  if (!res.ok) {
    console.warn('fcm oauth status', res.status);
    return undefined;
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return undefined;
  cached = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return cached.token;
}

/** Sends a content-free push. Returns 'unregistered' when the device token should be forgotten. */
export async function sendDoorbell(
  rawAccount: string,
  deviceToken: string,
  hint: PushHint,
): Promise<'sent' | 'unregistered' | 'error'> {
  const sa = parseAccount(rawAccount);
  if (!sa) return 'error';
  try {
    const bearer = await accessToken(sa);
    if (!bearer) return 'error';
    const text = TEXT[hint];
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: text.title, body: text.body },
          android: {
            priority: hint === 'approval' ? 'HIGH' : 'NORMAL',
            collapse_key: `heyloop-${hint}`,
            notification: { channel_id: text.channel, tag: `heyloop-${hint}` },
          },
        },
      }),
    });
    if (res.ok) return 'sent';
    console.warn('fcm send status', res.status);
    return res.status === 404 ? 'unregistered' : 'error';
  } catch {
    return 'error';
  }
}
