import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startWebhookReceiver } from '@agentevents/server';
import { monitoringMapping } from './contract';
import { createOpsServer } from './ops-server';
import { TENANT } from './app';

/**
 * Run the example MCP server over stdio, e.g. as a Claude Code MCP server. Clients without the
 * events extension still get events through the `get_new_events` fallback tool.
 *
 * Upstream webhooks: loopback only, Standard Webhooks HMAC. Set AGENTEVENTS_WEBHOOK_SECRET
 * (whsec_...) to the secret shared with the sender; there is no default.
 */
async function main(): Promise<void> {
  const secret = process.env['AGENTEVENTS_WEBHOOK_SECRET'];
  if (!secret?.startsWith('whsec_')) {
    process.stderr.write('AGENTEVENTS_WEBHOOK_SECRET must be set to a whsec_ secret\n');
    process.exit(1);
  }
  const ops = createOpsServer({ tenantid: TENANT });
  const receiver = await startWebhookReceiver({
    server: ops.events,
    host: '127.0.0.1',
    port: Number(process.env['AGENTEVENTS_WEBHOOK_PORT'] ?? 8787),
    routes: [{ path: '/hooks/monitoring', mappingId: monitoringMapping.id, tenantid: TENANT, secrets: () => [secret] }],
  });
  process.stderr.write(`webhooks: ${receiver.url}/hooks/monitoring\n`);
  await ops.events.mcp.connect(new StdioServerTransport());
}

void main();
