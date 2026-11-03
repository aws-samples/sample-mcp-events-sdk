import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF policy for client-supplied webhook URLs (spec gap 5, SEP-3415 security section).
 *
 * - HTTPS only. Plain HTTP is allowed only to a loopback address when `allowLoopbackHttpForDev`
 *   is set (local development); it is off by default.
 * - No credentials in the URL. No redirects (enforced by the deliverer).
 * - The host is resolved at DELIVERY time and every resolved address must be public; the
 *   connection is pinned to the validated address, so DNS rebinding cannot swap it.
 * - Optional hostname allowlist.
 */
export interface UrlPolicyOptions {
  allowLoopbackHttpForDev?: boolean;
  allowedHosts?: readonly string[];
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function family(ip: string): 'ipv4' | 'ipv6' {
  return isIP(ip) === 6 ? 'ipv6' : 'ipv4';
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is checked as the embedded IPv4 address. */
function normalize(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(ip);
  return m?.[1] ?? ip;
}

export const isPublicAddress = (ip: string): boolean => {
  const n = normalize(ip);
  return !blocked.check(n, family(n));
};
export const isLoopbackAddress = (ip: string): boolean => {
  const n = normalize(ip);
  return LOOPBACK.check(n, family(n));
};

export type UrlCheck =
  | { ok: true; url: URL; address: string; family: 4 | 6 }
  | { ok: false; reason: string };

/** Static checks only (at subscribe time). */
export function checkUrlShape(raw: string, opts: UrlPolicyOptions): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  if (url.hash) return { ok: false, reason: 'fragments are not allowed' };
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (opts.allowedHosts && !opts.allowedHosts.includes(host)) return { ok: false, reason: `host ${host} is not on the allowlist` };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && opts.allowLoopbackHttpForDev && (isIP(host) ? isLoopbackAddress(host) : host === 'localhost')) {
    return { ok: true, url };
  }
  return { ok: false, reason: 'webhook URLs must use https' };
}

/** Full check at delivery time: resolve and validate every address, return the one to pin. */
export async function resolveForDelivery(raw: string, opts: UrlPolicyOptions): Promise<UrlCheck> {
  const shape = checkUrlShape(raw, opts);
  if (!shape.ok) return shape;
  const host = shape.url.hostname.replace(/^\[|\]$/gu, '');
  let addrs: { address: string; family: number }[];
  try {
    addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `cannot resolve ${host}` };
  }
  if (!addrs.length) return { ok: false, reason: `cannot resolve ${host}` };
  const devLoopback = opts.allowLoopbackHttpForDev === true;
  for (const a of addrs) {
    const allowed = isPublicAddress(a.address) || (devLoopback && isLoopbackAddress(a.address));
    if (!allowed) return { ok: false, reason: `${host} resolves to a non-public address` };
  }
  if (shape.url.protocol === 'http:' && !addrs.every((a) => isLoopbackAddress(a.address))) {
    return { ok: false, reason: 'plain http is only allowed to loopback in development' };
  }
  const first = addrs[0]!;
  return { ok: true, url: shape.url, address: first.address, family: first.family === 6 ? 6 : 4 };
}
