import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookBody, webhooks, type Occurrence } from '@agentevents/contract';

interface Registration {
  secrets: () => readonly string[];
  onEvent: (o: Occurrence, subscriptionId: string) => void;
  subscriptionId?: string;
}

export interface HostWebhookEndpoint {
  baseUrl: string;
  /** Register an unguessable path token for one subscription. */
  register(token: string, reg: Registration): void;
  bind(token: string, subscriptionId: string): void;
  unregister(token: string): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return undefined;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Host-side receiver for SEP-3415 webhook delivery. Loopback by default: put a TLS-terminating,
 * authenticated ingress in front of it to receive from remote servers (servers refuse plain http
 * to anything but loopback). Every request must carry a valid Standard Webhooks signature made
 * with the secret this host chose for that subscription.
 */
export async function startHostWebhookEndpoint(opts: { host?: string; port?: number; maxBodyBytes?: number } = {}): Promise<HostWebhookEndpoint> {
  const regs = new Map<string, Registration>();
  const max = opts.maxBodyBytes ?? 512 * 1024;
  const http = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      const m = /^\/events\/([A-Za-z0-9_-]{16,})$/u.exec(new URL(req.url ?? '/', 'http://x').pathname);
      const reg = req.method === 'POST' && m?.[1] ? regs.get(m[1]) : undefined;
      if (!reg) return send(404);
      const raw = await readBody(req, max);
      if (raw === undefined) return send(413);
      const h = req.headers;
      const v = webhooks.verify(
        { 'webhook-id': h['webhook-id'] as string | undefined, 'webhook-timestamp': h['webhook-timestamp'] as string | undefined, 'webhook-signature': h['webhook-signature'] as string | undefined },
        raw,
        reg.secrets(),
        Math.floor(Date.now() / 1000),
      );
      if (!v.ok) return send(401);
      let body: WebhookBody;
      try {
        body = WebhookBody.parse(JSON.parse(raw));
      } catch {
        return send(400);
      }
      if (reg.subscriptionId && body.subscriptionId !== reg.subscriptionId) return send(404);
      if (body.type === 'challenge') return send(200, { challenge: body.challenge });
      reg.onEvent(body.event, body.subscriptionId);
      return send(204);
    })();
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r) => http.listen(opts.port ?? 0, host, r));
  const { port } = http.address() as AddressInfo;
  return {
    baseUrl: `http://${host}:${port}`,
    register: (token, reg) => regs.set(token, reg),
    bind: (token, id) => {
      const r = regs.get(token);
      if (r) r.subscriptionId = id;
    },
    unregister: (token) => regs.delete(token),
    close: () => new Promise((resolve, reject) => http.close((e) => (e ? reject(e) : resolve()))),
  };
}
