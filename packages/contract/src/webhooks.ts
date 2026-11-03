import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks (https://www.standardwebhooks.com) signing, as required by SEP-3415.
 * Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 hmac-sha256>`.
 * Secrets are `whsec_<base64>`. Verification accepts several secrets so rotation can overlap.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) throw new Error('webhook secret must start with whsec_');
  return Buffer.from(secret.slice('whsec_'.length), 'base64');
}

export function sign(secret: string, id: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestampSec}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export interface WebhookHeaders {
  'webhook-id'?: string;
  'webhook-timestamp'?: string;
  'webhook-signature'?: string;
}

export type VerifyResult =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: 'MISSING_HEADERS' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'BAD_SIGNATURE' };

export function verify(
  headers: WebhookHeaders,
  body: string,
  secrets: readonly string[],
  nowSec: number,
  toleranceSec = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sigHeader = headers['webhook-signature'];
  if (!id || !ts || !sigHeader || !/^\d+$/u.test(ts)) return { ok: false, reason: 'MISSING_HEADERS' };
  const timestamp = Number(ts);
  if (Math.abs(nowSec - timestamp) > toleranceSec) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };

  const presented = sigHeader
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s.slice(3), 'base64'));
  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, id, timestamp, body).slice(3), 'base64');
    if (presented.some((p) => p.length === expected.length && timingSafeEqual(p, expected))) {
      return { ok: true, id, timestamp };
    }
  }
  return { ok: false, reason: 'BAD_SIGNATURE' };
}

/** Sign with every active secret (rotation overlap): `v1,<a> v1,<b>`. Receivers accept any match. */
export function signAll(secrets: readonly string[], id: string, timestampSec: number, body: string): string {
  return secrets.map((s) => sign(s, id, timestampSec, body)).join(' ');
}
