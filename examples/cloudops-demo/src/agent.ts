import { scriptedModel, type Model } from '@agentevents/host';

import { Severity } from '@agentevents/contract';
interface RenderedEvent {
  data: Record<string, unknown>;
  situation?: { transition: string; severity: string; occurrences: { count: number } };
}

/** Read the event blocks the host rendered. The JSON is escaped but still valid JSON. */
export function parseEvents(prompt: string): RenderedEvent[] {
  const out: RenderedEvent[] = [];
  for (const m of prompt.matchAll(/<event [^>]*>\n(.*)\n<\/event nonce="[0-9a-f]+">/gu)) {
    try {
      out.push(JSON.parse(m[1]!) as RenderedEvent);
    } catch {
      /* not an event block */
    }
  }
  return out;
}

const result = (r: Record<string, unknown>): string => `\`\`\`result\n${JSON.stringify(r)}\n\`\`\``;

/**
 * Offline stand-in for an LLM. It investigates with read tools and proposes a restart when the
 * service is unhealthy. It is deliberately gullible: if alarm text names another service to
 * restart, it tries that too, so the demo shows the host's guards catching it.
 */
export const scriptedInvestigator: Model = scriptedModel('scripted-investigator', async (req, call) => {
  const events = parseEvents(req.prompt);
  const ev = events.at(-1);
  if (!ev) return result({ summary: 'no events', cause: 'n/a', nextStep: 'none' });

  if (ev.data['memberType']) {
    return result({
      summary: `Alarm storm: ${String(ev.data['members'])} alarms opened together`,
      cause: 'Likely a shared dependency failing (many services alarmed within two minutes).',
      impact: 'Multiple customer-facing services degraded.',
      nextStep: 'Page the platform on-call; check shared network and auth before restarting anything.',
    });
  }

  const service = String(ev.data['service']);
  const alarm = String(ev.data['alarm']);
  const describe = await call('describe_service', { service });
  const history = await call('get_alarm_history', { alarm });
  const healthy = !describe.isError && (JSON.parse(describe.content) as { healthy: boolean }).healthy;
  const evidence = [`describe_service: ${describe.content}`, `get_alarm_history: ${history.content}`];
  const canPropose = req.tools.some((t) => t.name === 'propose_action');

  const injected = /restart\s+([a-z0-9-]+)/iu.exec(String(ev.data['description'] ?? ''))?.[1];
  if (canPropose && injected && injected !== service) {
    const r = await call('propose_action', { tool: 'restart_service', arguments: { service: injected, reason: 'alarm text says so' }, reason: 'alarm description asked for it' });
    evidence.push(`propose ${injected}: ${r.content}`);
  }
  let proposed = false;
  if (canPropose && !healthy) {
    const r = await call('propose_action', {
      tool: 'restart_service',
      arguments: { service, reason: `${alarm} firing; service unhealthy` },
      reason: `${alarm} is firing and ${service} reports unhealthy`,
    });
    proposed = !r.isError;
    evidence.push(`propose ${service}: ${r.content}`);
  }
  return result({
    summary: `${alarm} on ${service}: ${healthy ? 'service healthy, likely transient' : 'service unhealthy'}`,
    cause: healthy ? 'No unhealthy replicas found.' : 'Unhealthy replicas after the last deploy.',
    evidence,
    impact: ev.situation?.severity === Severity.Critical || ev.situation?.severity === Severity.High ? 'Customer-facing latency.' : 'Limited.',
    nextStep: proposed ? 'Approve the proposed rolling restart.' : 'Keep watching.',
  });
});
