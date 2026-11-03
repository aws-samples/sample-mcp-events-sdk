import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { toOccurrence, webhooks, type EventEnvelope, type FilterSpec, type LastError, type SubscribeResult, type WebhookBody } from '@agentevents/contract';
import { decodeCursor, encodeCursor, iso, systemClock, type Clock, type EventLog } from '@agentevents/core';
import { checkUrlShape, resolveForDelivery, type UrlPolicyOptions } from './url-policy';

export interface WebhookDeliveryOptions extends UrlPolicyOptions {
  defaultTtlMs?: number;
  maxTtlMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Minimum gap between requests to one destination host. */
  perHostIntervalMs?: number;
  /** How long a rotated-out secret keeps signing deliveries. */
  rotationOverlapMs?: number;
  clock?: Clock;
}

interface Sub {
  id: string;
  tenant: string | undefined;
  names: Set<string>;
  filter?: FilterSpec;
  url: string;
  secrets: { secret: string; until?: number }[];
  ttlMs: number;
  expiresAt: number;
  last: number;
  status: 'active' | 'failing' | 'failed' | 'expired';
  lastError?: LastError;
  pumping: boolean;
}

export interface DeliveryDeps {
  log: EventLog;
  matches: (ev: EventEnvelope, names: Set<string>, filter: FilterSpec | undefined, tenant: string | undefined) => Promise<boolean>;
  checkNames: (names: string[]) => void;
  checkFilter: (filter: FilterSpec | undefined, names: string[]) => void;
}

type PostOutcome = { ok: true; body: string } | { ok: false; category: LastError['category'] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SEP-3415 webhook delivery: `events/subscribe` with a verification challenge, TTL and refresh,
 * Standard Webhooks signatures (with rotation overlap), at-least-once in-order delivery per
 * subscription with backoff, and SSRF-hardened outbound requests pinned to a validated address.
 */
export class WebhookDelivery {
  private readonly subs = new Map<string, Sub>();
  /** Verified (tenant, url) pairs: the challenge is answered once per pair. */
  private readonly verified = new Set<string>();
  private readonly hostNext = new Map<string, number>();
  private readonly clock: Clock;

  constructor(
    private readonly deps: DeliveryDeps,
    private readonly opts: WebhookDeliveryOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
  }

  get(id: string): Readonly<Sub> | undefined {
    return this.subs.get(id);
  }

  async subscribe(
    p: { subscriptionId?: string; names?: string[]; url?: string; secret?: string; ttlMs?: number; cursor?: string | null; filter?: FilterSpec },
    tenant: string | undefined,
  ): Promise<SubscribeResult & { secret?: string }> {
    const now = this.clock.now();
    const ttl = Math.min(p.ttlMs ?? this.opts.defaultTtlMs ?? 3_600_000, this.opts.maxTtlMs ?? 86_400_000);

    if (p.subscriptionId) {
      const s = this.subs.get(p.subscriptionId);
      if (!s || s.tenant !== tenant) throw new McpError(ErrorCode.InvalidParams, 'unknown subscription');
      if (p.secret && !s.secrets.some((x) => x.secret === p.secret)) {
        const until = now + (this.opts.rotationOverlapMs ?? 86_400_000);
        for (const x of s.secrets) x.until = Math.min(x.until ?? until, until);
        s.secrets.unshift({ secret: p.secret });
      }
      s.ttlMs = ttl;
      s.expiresAt = now + ttl;
      if (s.status !== 'active') {
        s.status = 'active';
        delete s.lastError;
      }
      void this.pump(s);
      return this.result(s);
    }

    if (!p.names?.length || !p.url) throw new McpError(ErrorCode.InvalidParams, 'names and url are required');
    this.deps.checkNames(p.names);
    this.deps.checkFilter(p.filter, p.names);
    const shape = checkUrlShape(p.url, this.opts);
    if (!shape.ok) throw new McpError(ErrorCode.InvalidParams, 'webhook url rejected', { lastError: { category: 'url_rejected', at: iso(now) } });

    const generated = p.secret ? undefined : webhooks.generateSecret();
    const secret = p.secret ?? generated!;
    let last: number;
    try {
      last = decodeCursor(p.cursor, await this.deps.log.head());
    } catch {
      throw new McpError(ErrorCode.InvalidParams, 'invalid cursor');
    }
    const s: Sub = {
      id: `whsub_${randomUUID()}`,
      tenant,
      names: new Set(p.names),
      ...(p.filter ? { filter: p.filter } : {}),
      url: p.url,
      secrets: [{ secret }],
      ttlMs: ttl,
      expiresAt: now + ttl,
      last,
      status: 'active',
      pumping: false,
    };

    const key = `${tenant ?? ''}\u0000${p.url}`;
    if (!this.verified.has(key)) {
      const challenge = randomBytes(18).toString('base64url');
      const res = await this.post(s, { type: 'challenge', subscriptionId: s.id, challenge }, `chal_${challenge}`);
      let echoed: unknown;
      try {
        echoed = res.ok ? (JSON.parse(res.body) as { challenge?: unknown }).challenge : undefined;
      } catch {
        echoed = undefined;
      }
      if (echoed !== challenge) {
        // Failures surface only as a category, never the endpoint's raw response.
        return { subscriptionId: s.id, ttlMs: 0, refreshBefore: iso(now), deliveryStatus: 'failed', lastError: { category: res.ok ? 'challenge_failed' : res.category, at: iso(now) }, cursor: encodeCursor(last) };
      }
      this.verified.add(key);
    }
    this.subs.set(s.id, s);
    void this.pump(s);
    return { ...this.result(s), ...(generated ? { secret: generated } : {}) };
  }

  unsubscribe(id: string, tenant: string | undefined): void {
    const s = this.subs.get(id);
    if (!s || s.tenant !== tenant) throw new McpError(ErrorCode.InvalidParams, 'unknown subscription');
    s.status = 'expired';
    this.subs.delete(id);
  }

  /** Called after each append to the log. */
  notify(): void {
    for (const s of this.subs.values()) void this.pump(s);
  }

  /** Wait until no subscription is mid-delivery (tests, shutdown). */
  async idle(): Promise<void> {
    while ([...this.subs.values()].some((s) => s.pumping)) await sleep(5);
  }

  private result(s: Sub): SubscribeResult {
    return {
      subscriptionId: s.id,
      ttlMs: s.ttlMs,
      refreshBefore: iso(s.expiresAt - Math.floor(s.ttlMs / 10)),
      deliveryStatus: s.status,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      cursor: encodeCursor(s.last),
    };
  }

  private async pump(s: Sub): Promise<void> {
    if (s.pumping) return;
    s.pumping = true;
    try {
      for (;;) {
        if (s.status !== 'active') return;
        if (this.clock.now() >= s.expiresAt) {
          s.status = 'expired';
          s.lastError = { category: 'expired', at: iso(this.clock.now()) };
          return;
        }
        const page = await this.deps.log.read(s.last, 50);
        if (!page.length) return;
        for (const item of page) {
          if (!(await this.deps.matches(item.event, s.names, s.filter, s.tenant))) {
            s.last = item.offset;
            continue;
          }
          const body: WebhookBody = { type: 'event', subscriptionId: s.id, cursor: encodeCursor(item.offset), event: toOccurrence(item.event) };
          const ok = await this.deliverWithRetry(s, body, `msg_${createHash('sha256').update(`${s.id}\u0000${item.event.id}`).digest('hex').slice(0, 32)}`);
          if (!ok) return; // cursor stays at the failed event; a refresh resumes from here
          s.last = item.offset;
        }
      }
    } finally {
      s.pumping = false;
    }
  }

  private async deliverWithRetry(s: Sub, body: WebhookBody, msgId: string): Promise<boolean> {
    const max = this.opts.maxAttempts ?? 6;
    let category: LastError['category'] = 'delivery_failed';
    for (let attempt = 1; attempt <= max; attempt++) {
      const r = await this.post(s, body, msgId);
      if (r.ok) {
        if (s.status === 'failing') s.status = 'active';
        return true;
      }
      category = r.category;
      if (category === 'url_rejected') break; // address became non-public: do not keep trying
      s.lastError = { category, at: iso(this.clock.now()), attempts: attempt };
      const base = Math.min((this.opts.baseBackoffMs ?? 500) * 2 ** (attempt - 1), this.opts.maxBackoffMs ?? 60_000);
      await sleep(base / 2 + Math.random() * (base / 2)); // exponential backoff with jitter
    }
    s.status = category === 'url_rejected' ? 'failed' : 'failing';
    s.lastError = { category, at: iso(this.clock.now()), attempts: max };
    return false;
  }

  private activeSecrets(s: Sub): string[] {
    const now = this.clock.now();
    s.secrets = s.secrets.filter((x) => x.until === undefined || x.until > now);
    return s.secrets.map((x) => x.secret);
  }

  private async post(s: Sub, body: WebhookBody, msgId: string): Promise<PostOutcome> {
    const target = await resolveForDelivery(s.url, this.opts);
    if (!target.ok) return { ok: false, category: 'url_rejected' };
    const host = target.url.host;
    const wait = (this.hostNext.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    this.hostNext.set(host, Date.now() + (this.opts.perHostIntervalMs ?? 20));

    const payload = JSON.stringify(body);
    const ts = Math.floor(this.clock.now() / 1000);
    const pinned: LookupFunction = (_h, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
      else cb(null, target.address, target.family);
    };
    const req = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
      method: 'POST',
      lookup: pinned,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'webhook-id': msgId,
        'webhook-timestamp': String(ts),
        'webhook-signature': webhooks.signAll(this.activeSecrets(s), msgId, ts, payload),
        'user-agent': 'agentevents-webhooks/0.1',
      },
      timeout: this.opts.timeoutMs ?? 10_000,
    });
    return new Promise<PostOutcome>((resolve) => {
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, category: 'timeout' });
      });
      req.on('error', () => resolve({ ok: false, category: 'delivery_failed' }));
      req.on('response', (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 65_536) chunks.push(c);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
          else resolve({ ok: false, category: status >= 300 && status < 400 ? 'redirect' : 'delivery_failed' }); // redirects are never followed
        });
      });
      req.end(payload);
    });
  }
}
