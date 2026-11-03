import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EVENTS_EXT, EXT } from '@agentevents/contract';
import { MemoryDecisionStore, type ThreadMemory } from '@agentevents/core';
import { EventHost, bedrockClaudeModel, claudeModel, type HostOptions, type Model } from '@agentevents/host';
import { CONFIG_REQUESTS, RULES, paper, reading } from './contract';
import { MemoryRuleLog, RuleStore } from '@agentevents/rules';
import { scriptedResearchAssistant } from './assistant';
import { PHASES, createLabServer, labFeed, type Phase } from './lab-server';

export const TENANT = 'lab-a';
export const RESEARCHER = 'dr.rivera@example.org';

export async function startLab(opts: { model?: Model; threadMemory?: ThreadMemory; host?: Partial<HostOptions> } = {}) {
  const lab = createLabServer({ tenantid: TENANT });
  // The configuration step: the researcher's requests become versioned, approved rules.
  const rules = await RuleStore.open(lab.events.registry, { log: new MemoryRuleLog() });
  const researcher = { id: RESEARCHER, roles: ['rule-owner'], origin: 'user' as const };
  const configuration: { request: string; ruleId: string; verdict: string; tier: string }[] = [];
  for (const r of RULES) {
    const { version: _v, ...rule } = r;
    const p = await rules.propose({ op: 'upsert', rule, request: CONFIG_REQUESTS[r.id] ?? r.description }, researcher);
    if (!p.ok || p.value.issues.length) throw new Error(`${r.id}: ${p.ok ? p.value.issues.map((i) => i.reason).join('; ') : p.reason}`);
    await rules.backtest(p.value.changeId, []);
    const a = await rules.approve(p.value.changeId, p.value.fingerprint, researcher);
    if (!a.ok) throw new Error(`${r.id}: ${a.reason}`);
    await rules.deploy(p.value.changeId, 'live');
    configuration.push({ request: CONFIG_REQUESTS[r.id] ?? r.description, ruleId: r.id, verdict: r.verdict, tier: p.value.tier });
  }
  const decisions = new MemoryDecisionStore();
  const host = new EventHost({
    model: opts.model ?? (process.env['AGENTEVENTS_MODEL'] === 'bedrock' ? bedrockClaudeModel() : process.env['AGENTEVENTS_MODEL'] === 'claude' ? claudeModel() : scriptedResearchAssistant),
    owner: { id: RESEARCHER, tenantid: TENANT },
    rules: () => rules.live(),
    decisions,
    coalesceMs: 200,
    maxTurnsPerHour: 200,
    ...(opts.threadMemory ? { threadMemory: opts.threadMemory } : {}),
    ...opts.host,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'research-host', version: '0.1.0' }, { capabilities: { extensions: { [EVENTS_EXT]: {}, [EXT.contract]: {} } } });
  await lab.events.mcp.connect(b);
  await client.connect(a);
  await host.attach(client, { names: [reading.type, paper.type], mode: 'stream' });

  const phases = labFeed({ startMs: Date.now() - 25 * 60_000, spanMs: 24 * 60_000 });

  /** Push one phase of the synthetic lab feed through the published mappings (hop 1), then settle. */
  async function feed(phase: Phase): Promise<{ sent: number; outcomes: Record<string, number> }> {
    const items = phases.get(phase) ?? [];
    const outcomes: Record<string, number> = {};
    for (const it of items) {
      const r = await lab.events.ingestRaw(it.mapping, it.payload, { tenantid: TENANT });
      outcomes[r.code] = (outcomes[r.code] ?? 0) + 1;
    }
    await new Promise((r) => setTimeout(r, 50));
    await host.settle();
    return { sent: items.length, outcomes };
  }

  return {
    lab,
    host,
    rules,
    configuration,
    decisions,
    feed,
    phases: PHASES.map((p) => p.phase),
    async close() {
      await host.close();
      await client.close();
    },
  };
}
