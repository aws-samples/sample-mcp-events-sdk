import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EXT, Severity } from '@agentevents/contract';
import type { EventLog, RuntimeState } from '@agentevents/core';
import { EventServer } from '@agentevents/server';
import { OutcomeUnknownError, WriteLedger, defineAction, Tier } from '@agentevents/actions';
import { PLATFORM_PRINCIPAL, alarmSituation, alarmState, alarmStorm, monitoringMapping, situationConfig } from './contract';

/** A fake fleet, so the example runs without cloud credentials. */
export interface ServiceState {
  service: string;
  healthy: boolean;
  replicas: number;
  version: string;
  lastRestart?: string;
  restarts: number;
}

export interface OpsServer {
  events: EventServer;
  fleet: Map<string, ServiceState>;
  alarmHistory: Map<string, { time: string; state: string; value?: number }[]>;
  ledger: WriteLedger;
  /** Feed a monitoring payload as the platform would after it observed something. */
  emitMonitoring: (payload: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The example's MCP server: built entirely on the SDK. Event types, mapping and situations are
 * declared next to read tools and one reversible action.
 */
export function createOpsServer(opts: { tenantid: string; log?: EventLog; state?: RuntimeState }): OpsServer {
  const events = new EventServer({
    name: 'cloudops-demo',
    version: '0.1.0',
    platformPrincipals: [PLATFORM_PRINCIPAL],
    sessionTenant: () => opts.tenantid,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.state ? { state: opts.state } : {}),
  });
  events
    .defineEvent(alarmState, { internal: true })
    .defineEvent(alarmSituation)
    .defineEvent(alarmStorm)
    .addMapping(monitoringMapping)
    .addSituation(situationConfig);

  const fleet = new Map<string, ServiceState>(
    ['checkout-api', 'payments-db', 'search', 'cart', 'orders', 'inventory', 'auth'].map((s) => [
      s,
      { service: s, healthy: true, replicas: 3, version: '2026.11.1', restarts: 0 },
    ]),
  );
  const alarmHistory = new Map<string, { time: string; state: string; value?: number }[]>();
  const ledger = new WriteLedger();

  // Keep the fake fleet in step with what monitoring reports (every ingest path, webhooks included).
  events.onEvent((ev) => {
    if (ev.type !== alarmState.type) return;
    const d = ev.data as { alarm: string; service: string; state: string; value?: number };
    const svc = fleet.get(d.service);
    if (svc && d.state === 'ALARM') svc.healthy = false;
    const list = alarmHistory.get(d.alarm) ?? [];
    list.push({ time: ev.time, state: d.state, ...(d.value !== undefined ? { value: d.value } : {}) });
    alarmHistory.set(d.alarm, list);
  });

  const emitMonitoring = (payload: Record<string, unknown>): Promise<unknown> =>
    events.ingestRaw(monitoringMapping.id, payload, { tenantid: opts.tenantid });

  const safe = { [EXT.actions]: { tier: Tier.Safe } };

  events.mcp.registerTool(
    'describe_service',
    {
      description: 'Current health, replicas, version and last restart of a service.',
      inputSchema: { service: z.string() },
      annotations: { readOnlyHint: true },
      _meta: safe,
    },
    ({ service }) => {
      const s = fleet.get(service);
      if (!s) return { isError: true, content: [{ type: 'text', text: `unknown service ${service}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(s) }], structuredContent: { ...s } };
    },
  );

  events.mcp.registerTool(
    'get_alarm_history',
    {
      description: 'Recent state changes of an alarm.',
      inputSchema: { alarm: z.string() },
      annotations: { readOnlyHint: true },
      _meta: safe,
    },
    ({ alarm }) => {
      const h = alarmHistory.get(alarm) ?? [];
      return { content: [{ type: 'text', text: JSON.stringify(h.slice(-10)) }], structuredContent: { alarm, history: h.slice(-10) } };
    },
  );

  defineAction(
    events.mcp,
    ledger,
    'restart_service',
    {
      description: 'Rolling restart of a service. Reversible: replicas come back on the same version.',
      tier: Tier.Reversible,
      targetArg: 'service',
      inputSchema: { service: z.string(), reason: z.string() },
    },
    async ({ service }, ctx) => {
      const s = fleet.get(service);
      if (!s) return { isError: true, content: [{ type: 'text', text: `unknown service ${service}` }] };
      if (service === 'payments-db') throw new OutcomeUnknownError('control plane timed out mid-restart');
      s.healthy = true;
      s.restarts += 1;
      s.lastRestart = new Date().toISOString();
      // The restart clears the alarm. Monitoring reports it as changed by OUR role, with causation.
      const open = [...alarmHistory.entries()].filter(([name, h]) => name.startsWith(service) && h.at(-1)?.state === 'ALARM');
      for (const [name] of open) {
        await emitMonitoring({
          eventId: `evt-${randomUUID()}`,
          account: '111122223333',
          region: 'us-east-1',
          time: new Date().toISOString(),
          changedBy: PLATFORM_PRINCIPAL,
          causation: ctx.actionId,
          alarm: { name, service, env: 'prod', state: 'OK', severity: Severity.High, metric: 'p99_latency_ms', value: 120, threshold: 1000, description: 'recovered after restart' },
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify({ service, restarted: true, restarts: s.restarts }) }] };
    },
  );

  return { events, fleet, alarmHistory, ledger, emitMonitoring };
}
