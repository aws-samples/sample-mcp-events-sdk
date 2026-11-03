import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { webhooks } from '@agentevents/contract';
import type { Clock } from '@agentevents/core';
import { systemClock } from '@agentevents/core';
import type { EventServer } from './event-server';

/**
 * A route binds an inbound URL to a mapping and a tenant. The tenant comes from this binding,
 * never from the payload (spec A7).
 */
export interface WebhookRoute {
  path: string;
  mappingId: string;
  tenantid?: string;
  /** Standard Webhooks secrets. More than one = rotation overlap; all verify until the old one is removed. */
  secrets: () => readonly string[];
}

export interface WebhookReceiverOptions {
  server: EventServer;
  routes: WebhookRoute[];
  /** Defaults to loopback. Widening this exposes the receiver beyond this machine. */
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  clock?: Clock;
}

export interface WebhookReceiver {
  url: string;
  close(): Promise<void>;
  server: Server;
}

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Upstream ingest adapter (hop 1): Standard Webhooks verification, body cap, then the contract
 * pipeline. Status codes tell the sender whether to retry: 2xx done, 4xx refused (do not retry),
 * 5xx retry.
 */
export async function startWebhookReceiver(opts: WebhookReceiverOptions): Promise<WebhookReceiver> {
  const host = opts.host ?? '127.0.0.1';
  const max = opts.maxBodyBytes ?? 256 * 1024;
  const clock = opts.clock ?? systemClock;
  const routes = new Map(opts.routes.map((r) => [r.path, r]));

  const http = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: Record<string, unknown>): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const route = req.method === 'POST' ? routes.get(new URL(req.url ?? '/', 'http://x').pathname) : undefined;
      if (!route) return send(404, { error: 'not found' });
      const body = await readBody(req, max);
      if (body === undefined) return send(413, { error: 'body too large' });
      const h = req.headers;
      const verified = webhooks.verify(
        {
          'webhook-id': h['webhook-id'] as string | undefined,
          'webhook-timestamp': h['webhook-timestamp'] as string | undefined,
          'webhook-signature': h['webhook-signature'] as string | undefined,
        },
        body,
        route.secrets(),
        Math.floor(clock.now() / 1000),
      );
      if (!verified.ok) return send(401, { error: verified.reason });
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        return send(400, { error: 'invalid JSON' });
      }
      try {
        const out = await opts.server.ingestRaw(route.mappingId, raw, {
          ...(route.tenantid ? { tenantid: route.tenantid } : {}),
          deliveryId: verified.id,
        });
        if (out.code.startsWith('REFUSED')) return send(400, { code: out.code, reason: out.reason });
        return send(202, { code: out.code, ids: out.ids });
      } catch (e) {
        return send(503, { error: 'retry', reason: (e as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, host, resolve));
  const addr = http.address() as AddressInfo;
  return {
    url: `http://${host}:${addr.port}`,
    server: http,
    close: () => new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve()))),
  };
}
