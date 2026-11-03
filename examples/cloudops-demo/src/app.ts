import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EVENTS_EXT, EXT, webhooks, type EventEnvelope, Autonomy, DeliveryMode, Verdict, FilterLanguage, Severity, Transition } from '@agentevents/contract';
import { MemoryDecisionStore, readAll, type Decision, type DecisionStore, type EventLog, type Rule, type RuntimeState } from '@agentevents/core';
import { EventHost, bedrockClaudeModel, claudeModel, type HostOptions, type Model } from '@agentevents/host';
import { FileRuleLog, MemoryRuleLog, RuleStore, createRulesServer, type Principal, type RuleLog, ChangeOp, DeployMode, RequestOrigin } from '@agentevents/rules';
import { startWebhookReceiver, type WebhookReceiver } from '@agentevents/server';
import { alarmSituation, alarmStorm } from './contract';
import { scriptedInvestigator } from './agent';
import { createOpsServer, type OpsServer } from './ops-server';

export const TENANT = 'acme';
export const OWNER: Principal = { id: 'pat@acme.example', roles: ['rule-owner'], origin: RequestOrigin.User };

/**
 * What the on-call owner tells agentevents to let through, in their own words, and the structured rule
 * each request becomes. Configured through the rule lifecycle (propose, backtest, approve, deploy).
 */
export const SEED_RULES: Rule[] = [
  {
    id: 'prod-high-propose',
    version: 1,
    priority: 20,
    description: 'Wake on new high/critical prod alarms; the agent may propose fixes',
    types: [alarmSituation.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'data.env': ['prod'], 'situation.transition': [Transition.Open], 'situation.severity': [Severity.High, Severity.Critical] } },
    verdict: Verdict.Wake,
    autonomy: Autonomy.Propose,
  },
  {
    id: 'prod-open-investigate',
    version: 1,
    priority: 50,
    description: 'Wake on any new prod alarm; investigate only',
    types: [alarmSituation.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'data.env': ['prod'], 'situation.transition': [Transition.Open] } },
    verdict: Verdict.Wake,
    autonomy: Autonomy.Investigate,
  },
  {
    id: 'staging-store',
    version: 1,
    priority: 30,
    description: 'Store staging alarms without waking',
    types: [alarmSituation.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'data.env': ['staging', 'dev'] } },
    verdict: Verdict.Store,
  },
  {
    id: 'storm-investigate',
    version: 1,
    priority: 10,
    description: 'Wake once for an alarm storm',
    types: [alarmStorm.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'situation.transition': [Transition.Open] } },
    verdict: Verdict.Wake,
    autonomy: Autonomy.Investigate,
  },
];

export const CONFIG_REQUESTS: Record<string, string> = {
  'prod-high-propose': 'Wake me for new high or critical production alarms, and let the agent propose a fix.',
  'prod-open-investigate': 'For any other new production alarm, just have the agent investigate.',
  'staging-store': 'Never wake anyone for staging or dev; keep those alarms searchable.',
  'storm-investigate': 'If many alarms fire at once, give me one storm, not one page per alarm.',
};

export interface ConfiguredRule {
  request: string;
  ruleId: string;
  verdict: string;
  autonomy?: string;
  tier: string;
  approvedBy: string;
}

/**
 * The configuration step: each plain-language request goes through the rule lifecycle. Skipped when the
 * rule store already has live rules (for example after a restart on DynamoDB).
 */
export async function configureRules(rules: RuleStore, by: Principal, rulesList: Rule[], requests: Record<string, string>): Promise<ConfiguredRule[]> {
  if (rules.live().length) return [];
  const out: ConfiguredRule[] = [];
  for (const r of rulesList) {
    const { version: _v, ...rule } = r;
    const request = requests[r.id] ?? r.description;
    const p = await rules.propose({ op: ChangeOp.Upsert, rule, request }, by);
    if (!p.ok) throw new Error(`${r.id}: ${p.reason}`);
    if (p.value.issues.length) throw new Error(`${r.id}: ${p.value.issues.map((i) => i.reason).join('; ')}`);
    await rules.backtest(p.value.changeId, []);
    const a = await rules.approve(p.value.changeId, p.value.fingerprint, by);
    if (!a.ok) throw new Error(`${r.id}: ${a.reason}`);
    await rules.deploy(p.value.changeId, DeployMode.Live);
    out.push({ request, ruleId: r.id, verdict: r.verdict, ...(r.autonomy ? { autonomy: r.autonomy } : {}), tier: p.value.tier, approvedBy: by.id });
  }
  return out;
}

export interface App {
  ops: OpsServer;
  host: EventHost;
  rules: RuleStore;
  decisions: DecisionStore;
  /** The configuration step's result: what the owner asked for and the rule it became. */
  configuration: ConfiguredRule[];
  /** All decisions so far, oldest first. */
  allDecisions(): Promise<Decision[]>;
  rulesClient: Client;
  receiver: WebhookReceiver;
  secret: string;
  stop: { stopped: boolean };
  close(): Promise<void>;
}

async function connect(server: McpServer, name: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name, version: '0.1.0' },
    { capabilities: { extensions: { [EVENTS_EXT]: {}, [EXT.contract]: {}, [EXT.activation]: {} } } },
  );
  await server.connect(serverSide);
  await client.connect(clientSide);
  return client;
}

export function pickModel(): Model {
  const m = process.env['AGENTEVENTS_MODEL'];
  // bedrock: Claude on Amazon Bedrock (recommended for production). claude: direct API, for local development.
  return m === 'bedrock' ? bedrockClaudeModel() : m === 'claude' ? claudeModel() : scriptedInvestigator;
}

/** Pluggable stores. Defaults are in memory; see `@agentevents/store-dynamodb` for DynamoDB. */
export interface AppStores {
  serverLog?: EventLog;
  serverState?: RuntimeState;
  hostState?: RuntimeState;
  decisions?: DecisionStore;
  ruleLog?: RuleLog;
}

export async function startApp(opts: { model?: Model; rulesPath?: string; host?: Partial<HostOptions>; stores?: AppStores } = {}): Promise<App> {
  const st = opts.stores ?? {};
  const ops = createOpsServer({ tenantid: TENANT, ...(st.serverLog ? { log: st.serverLog } : {}), ...(st.serverState ? { state: st.serverState } : {}) });

  // Rule store: persisted, versioned. The owner configures what the agent hears (once).
  const rules = await RuleStore.open(ops.events.registry, { log: st.ruleLog ?? (opts.rulesPath ? new FileRuleLog(opts.rulesPath) : new MemoryRuleLog()) });
  const configuration = await configureRules(rules, OWNER, SEED_RULES, CONFIG_REQUESTS);
  const decisions = st.decisions ?? new MemoryDecisionStore();

  const stop = { stopped: false };
  const host = new EventHost({
    model: opts.model ?? pickModel(),
    owner: { id: OWNER.id, tenantid: TENANT },
    rules: () => rules.live(),
    decisions,
    ...(st.hostState ? { state: st.hostState } : {}),
    emergencyStop: { state: () => (stop.stopped ? 'stopped' : 'running') },
    coalesceMs: 300,
    maxTurnsPerHour: 20,
    ...opts.host,
  });
  const opsClient = await connect(ops.events.mcp, 'cloudops-host');
  await host.attach(opsClient, { names: [alarmSituation.type, alarmStorm.type], mode: DeliveryMode.Stream });

  // The user's own chat session talks to the rules server; event-triggered turns never see it.
  const rulesServer = createRulesServer({
    store: rules,
    history: async () => (await readAll(ops.events.log)).filter((e: EventEnvelope) => e.type === alarmSituation.type || e.type === alarmStorm.type),
    decisions,
    principal: () => OWNER,
  });
  const rulesClient = await connect(rulesServer, 'pat-chat-session');

  // Upstream webhooks: Standard Webhooks HMAC, loopback only, tenant bound to the route.
  const secret = webhooks.generateSecret();
  const receiver = await startWebhookReceiver({
    server: ops.events,
    routes: [{ path: '/hooks/monitoring', mappingId: 'monitoring.alarm->ops.alarm_state', tenantid: TENANT, secrets: () => [secret] }],
  });

  return {
    ops,
    host,
    rules,
    decisions,
    configuration,
    allDecisions: async () => (await decisions.recent(100_000)).reverse(),
    rulesClient,
    receiver,
    secret,
    stop,
    async close() {
      await host.close();
      await receiver.close();
      await opsClient.close();
      await rulesClient.close();
    },
  };
}

export async function sendWebhook(app: App, payload: Record<string, unknown>, opts: { id?: string; secret?: string } = {}): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${String(payload['eventId'])}`;
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${app.receiver.url}/hooks/monitoring`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': webhooks.sign(opts.secret ?? app.secret, id, ts, body),
    },
    body,
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
export function alarmPayload(a: { service: string; env?: string; state?: 'ALARM' | 'OK'; severity?: string; name?: string; description?: string; value?: number; time?: string }): Record<string, unknown> {
  seq += 1;
  return {
    eventId: `evt-${Date.now()}-${seq}`,
    account: '111122223333',
    region: 'us-east-1',
    time: a.time ?? new Date().toISOString(),
    changedBy: 'monitoring.amazonaws.com',
    alarm: {
      name: a.name ?? `${a.service}-p99`,
      service: a.service,
      env: a.env ?? 'prod',
      state: a.state ?? 'ALARM',
      severity: a.severity ?? 'high',
      metric: 'p99_latency_ms',
      value: a.value ?? 2300,
      threshold: 1000,
      description: a.description ?? 'p99 latency above 1s for 5 minutes',
      onCall: 'oncall@acme.example',
    },
  };
}
