import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SubscribeResult, WEBHOOK_METHODS, webhooks, type EventTypeDef, type WebhookBody, DeliveryMode, DeliveryStatus, Verdict } from '@agentevents/contract';
import { EventHost, scriptedModel, startHostWebhookEndpoint } from '@agentevents/host';
import { EventServer, checkUrlShape, resolveForDelivery } from '@agentevents/server';
import { makeEvent } from '@agentevents/testkit';

const def: EventTypeDef = {
  type: 'com.example.t.ping.v1',
  version: '1.0.0',
  title: 'ping',
  dataschema: 'https://s.example.com/ping.json',
  schema: { type: 'object', properties: { n: { type: 'number', 'x-event': { filterable: true } } } },
};

interface Received {
  headers: IncomingHttpHeaders;
  raw: string;
  body: WebhookBody;
}

/** A controllable receiver on loopback. */
async function receiver(behave: (b: WebhookBody, n: number) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const got: Received[] = [];
  let n = 0;
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw) as WebhookBody;
      got.push({ headers: req.headers, raw, body });
      const r = behave(body, n++);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body === undefined ? '' : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, got, close: () => new Promise((r) => http.close(r)) };
}

const echo = (b: WebhookBody) => (b.type === 'challenge' ? { status: 200, body: { challenge: b.challenge } } : { status: 204 });
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function setup(delivery: ConstructorParameters<typeof EventServer>[0]['webhookDelivery'] = {}) {
  const server = new EventServer({ name: 't', version: '1', webhookDelivery: { allowLoopbackHttpForDev: true, baseBackoffMs: 5, maxBackoffMs: 20, maxAttempts: 3, perHostIntervalMs: 0, ...delivery } });
  server.defineEvent(def);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await server.mcp.connect(b);
  await client.connect(a);
  closers.push(() => client.close());
  const subscribe = (params: Record<string, unknown>) => client.request({ method: WEBHOOK_METHODS.subscribe, params }, SubscribeResult);
  const ingest = (n: number) => server.ingest(makeEvent(def, { n }, { time: new Date().toISOString(), receivedat: new Date().toISOString(), source: `s${n}` }));
  const idle = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await server.delivery!.idle();
  };
  return { server, client, subscribe, ingest, idle };
}

describe('url policy (SSRF)', () => {
  it('rejects non-https, credentials, and non-public addresses; dev loopback is opt-in', async () => {
    expect(checkUrlShape('http://example.com/h', {}).ok).toBe(false);
    expect(checkUrlShape('https://u:p@example.com/h', {}).ok).toBe(false);
    expect(checkUrlShape('https://example.com/h', {}).ok).toBe(true);
    expect(checkUrlShape('http://127.0.0.1:9/h', {}).ok).toBe(false);
    expect(checkUrlShape('http://127.0.0.1:9/h', { allowLoopbackHttpForDev: true }).ok).toBe(true);
    expect(checkUrlShape('https://evil.example/h', { allowedHosts: ['hooks.example.com'] }).ok).toBe(false);
    for (const u of ['https://10.0.0.5/h', 'https://169.254.169.254/latest', 'https://[::ffff:127.0.0.1]/h', 'https://192.168.1.1/h', 'https://[fd00::1]/h', 'https://127.0.0.1/h']) {
      expect((await resolveForDelivery(u, {})).ok, u).toBe(false);
    }
    expect((await resolveForDelivery('https://localhost/h', {})).ok).toBe(false);
    expect((await resolveForDelivery('https://8.8.8.8/h', {})).ok).toBe(true);
  });
});

describe('SEP-3415 webhook delivery', () => {
  it('verifies with a challenge, then delivers signed events in order with stable ids', async () => {
    const r = await receiver(echo);
    closers.push(r.close);
    const { subscribe, ingest, idle } = await setup();
    const secret = webhooks.generateSecret();
    const sub = await subscribe({ names: [def.type], url: r.url, secret, ttlMs: 60_000 });
    expect(sub).toMatchObject({ deliveryStatus: DeliveryStatus.Active, ttlMs: 60_000 });
    for (const n of [1, 2, 3]) await ingest(n);
    await idle();
    const events = r.got.filter((g) => g.body.type === 'event');
    expect(events.map((g) => (g.body as unknown as { event: { data: { n: number } } }).event.data.n)).toEqual([1, 2, 3]);
    for (const g of [r.got[0]!, ...events]) {
      const h = g.headers;
      expect(webhooks.verify({ 'webhook-id': h['webhook-id'] as string, 'webhook-timestamp': h['webhook-timestamp'] as string, 'webhook-signature': h['webhook-signature'] as string }, g.raw, [secret], Math.floor(Date.now() / 1000)).ok).toBe(true);
    }
  });

  it('fails the subscription when the endpoint does not echo the challenge', async () => {
    const r = await receiver(() => ({ status: 200, body: { nope: true } }));
    closers.push(r.close);
    const { subscribe, ingest, idle } = await setup();
    const sub = await subscribe({ names: [def.type], url: r.url, secret: webhooks.generateSecret() });
    expect(sub).toMatchObject({ deliveryStatus: DeliveryStatus.Failed, lastError: { category: 'challenge_failed' } });
    await ingest(1);
    await idle();
    expect(r.got.filter((g) => g.body.type === 'event')).toHaveLength(0);
  });

  it('refuses private-network URLs (SSRF) at subscribe and at delivery', async () => {
    const { subscribe } = await setup();
    await expect(subscribe({ names: [def.type], url: 'http://10.0.0.5/h', secret: webhooks.generateSecret() })).rejects.toThrow(/url rejected/u);
    const viaHttps = await subscribe({ names: [def.type], url: 'https://169.254.169.254/latest/meta-data', secret: webhooks.generateSecret() });
    expect(viaHttps).toMatchObject({ deliveryStatus: DeliveryStatus.Failed, lastError: { category: 'url_rejected' } });
  });

  it('retries with backoff; after exhausting, pauses at the failed event and resumes on refresh (at-least-once)', async () => {
    let down = true;
    const r = await receiver((b) => (b.type === 'challenge' ? echo(b) : down ? { status: 503 } : { status: 204 }));
    closers.push(r.close);
    const { server, subscribe, ingest, idle } = await setup();
    const sub = await subscribe({ names: [def.type], url: r.url, secret: webhooks.generateSecret() });
    await ingest(1);
    await ingest(2);
    await idle();
    expect(server.delivery!.get(sub.subscriptionId)).toMatchObject({ status: DeliveryStatus.Failing, lastError: { category: 'delivery_failed', attempts: 3 } });
    expect(r.got.filter((g) => g.body.type === 'event').length).toBe(3); // 3 attempts at event 1, none at event 2
    down = false;
    expect((await subscribe({ subscriptionId: sub.subscriptionId })).deliveryStatus).toBe(DeliveryStatus.Active);
    await idle();
    const ok = r.got.filter((g) => g.body.type === 'event').slice(3);
    expect(ok.map((g) => (g.body as unknown as { event: { data: { n: number } } }).event.data.n)).toEqual([1, 2]);
    const ids = r.got.filter((g) => g.body.type === 'event' && (g.body as unknown as { event: { data: { n: number } } }).event.data.n === 1).map((g) => g.headers['webhook-id']);
    expect(new Set(ids).size).toBe(1); // retries reuse the webhook-id, so receivers can dedupe
  });

  it('never follows redirects', async () => {
    const r = await receiver((b) => (b.type === 'challenge' ? echo(b) : { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    closers.push(r.close);
    const { server, subscribe, ingest, idle } = await setup();
    const sub = await subscribe({ names: [def.type], url: r.url, secret: webhooks.generateSecret() });
    await ingest(1);
    await idle();
    expect(server.delivery!.get(sub.subscriptionId)?.lastError?.category).toBe('redirect');
  });

  it('rotates secrets with an overlap window: both old and new verify', async () => {
    const r = await receiver(echo);
    closers.push(r.close);
    const { subscribe, ingest, idle } = await setup();
    const oldS = webhooks.generateSecret();
    const newS = webhooks.generateSecret();
    const sub = await subscribe({ names: [def.type], url: r.url, secret: oldS });
    await subscribe({ subscriptionId: sub.subscriptionId, secret: newS });
    await ingest(1);
    await idle();
    const g = r.got.filter((x) => x.body.type === 'event').at(-1)!;
    const h = { 'webhook-id': g.headers['webhook-id'] as string, 'webhook-timestamp': g.headers['webhook-timestamp'] as string, 'webhook-signature': g.headers['webhook-signature'] as string };
    expect(h['webhook-signature'].split(' ')).toHaveLength(2);
    const now = Math.floor(Date.now() / 1000);
    expect(webhooks.verify(h, g.raw, [newS], now).ok).toBe(true);
    expect(webhooks.verify(h, g.raw, [oldS], now).ok).toBe(true);
  });

  it('stops at TTL expiry and after unsubscribe', async () => {
    const r = await receiver(echo);
    closers.push(r.close);
    const { server, client, subscribe, ingest, idle } = await setup();
    const short = await subscribe({ names: [def.type], url: r.url, secret: webhooks.generateSecret(), ttlMs: 30 });
    await new Promise((res) => setTimeout(res, 60));
    await ingest(1);
    await idle();
    expect(server.delivery!.get(short.subscriptionId)?.status).toBe(DeliveryStatus.Expired);
    const before = r.got.length;
    const sub = await subscribe({ names: [def.type], url: r.url, secret: webhooks.generateSecret() });
    await client.request({ method: WEBHOOK_METHODS.unsubscribe, params: { subscriptionId: sub.subscriptionId } }, EmptyResultSchema);
    await ingest(2);
    await idle();
    expect(r.got.slice(before).filter((g) => g.body.type === 'event')).toHaveLength(0);
  });
});

describe('host webhook mode', () => {
  it('receives over webhooks, wakes a turn, and rejects forged posts', async () => {
    const { server, client, ingest } = await setup();
    const endpoint = await startHostWebhookEndpoint();
    closers.push(endpoint.close);
    const model = scriptedModel('s', async () => '```result\n{"summary":"ok","cause":"c","nextStep":"n"}\n```');
    const host = new EventHost({ model, owner: { id: 'u' }, rules: () => [{ id: 'w', version: 1, description: 'wake', types: [def.type], verdict: Verdict.Wake }], coalesceMs: 10 });
    await host.attach(client, { names: [def.type], mode: DeliveryMode.Webhook, webhook: { endpoint } });
    await ingest(7);
    await new Promise((r) => setTimeout(r, 50));
    await server.delivery!.idle();
    await host.settle();
    expect(host.turns).toHaveLength(1);

    const rotated = await host.rotateWebhookSecret();
    expect(rotated.deliveryStatus).toBe(DeliveryStatus.Active);
    await ingest(8);
    await new Promise((r) => setTimeout(r, 50));
    await host.settle();
    expect(host.metrics.events).toBe(2);

    const forged = await fetch(`${endpoint.baseUrl}/events/${'x'.repeat(24)}`, { method: 'POST', body: '{}' });
    expect(forged.status).toBe(404);
    await host.close();
  });
});
