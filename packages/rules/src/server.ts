import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EXT, SPEC_VERSION, type EventEnvelope } from '@agentevents/contract';
import { TRACE, type DecisionStore, type Rule } from '@agentevents/core';
import type { Principal, Result, RuleStore } from './store';

export interface RulesServerOptions {
  store: RuleStore;
  /** Recent event history for backtests (read from the event log). */
  history: () => readonly EventEnvelope[] | Promise<readonly EventEnvelope[]>;
  decisions: DecisionStore;
  /** The authenticated principal of this MCP session. Never taken from tool arguments. */
  principal: () => Principal;
}

const json = (v: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
  structuredContent: v as Record<string, unknown>,
  ...(isError ? { isError: true } : {}),
});
const out = <T>(r: Result<T>): CallToolResult => (r.ok ? json(r.value) : json({ code: r.code, reason: r.reason }, true));

const FilterSchema = z.union([
  z.object({ language: z.literal('eb-pattern'), expression: z.record(z.string(), z.array(z.unknown())) }),
  z.object({ language: z.literal('jsonata'), expression: z.string() }),
]);

const RuleInput = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  description: z.string(),
  types: z.array(z.string()).min(1),
  filter: FilterSchema.optional(),
  window: z.object({ operator: z.literal('threshold'), count: z.number().int(), windowSeconds: z.number().int(), by: z.string() }).optional(),
  verdict: z.enum(['drop', 'store', 'digest', 'wake', 'decide', 'escalate']),
  autonomy: z.enum(['notify', 'investigate', 'propose', 'act']).optional(),
  mandatory: z.boolean().optional(),
  priority: z.number().int().optional(),
});

/**
 * Spec E5: the rule engine as an MCP server. A user asks in plain language; the LLM translates to
 * a structured diff; the server validates, backtests, and enforces risk-tier approval.
 */
export function createRulesServer(opts: RulesServerOptions): McpServer {
  const mcp = new McpServer({ name: 'agentevents-rules', version: SPEC_VERSION }, { capabilities: { tools: {}, extensions: { [EXT.rules]: { version: SPEC_VERSION } } } });
  const { store } = opts;
  const meta = { [EXT.actions]: { tier: 'safe' } };

  mcp.registerTool('rules_list', { description: 'List live and shadow rules with versions.', annotations: { readOnlyHint: true }, _meta: meta }, () =>
    json({ live: store.live(), shadow: store.shadow() }),
  );

  mcp.registerTool('rules_get', { description: 'Version history of one rule.', inputSchema: { ruleId: z.string() }, annotations: { readOnlyHint: true }, _meta: meta }, ({ ruleId }) =>
    json({ history: store.history(ruleId) }),
  );

  mcp.registerTool(
    'rules_propose',
    {
      description:
        'Propose a structured rule change. Translate the user request into a rule (never store prose). Attach the original request verbatim. Returns validation issues and the risk tier.',
      inputSchema: { op: z.enum(['upsert', 'retire']), rule: RuleInput, request: z.string() },
      _meta: { [EXT.actions]: { tier: 'reversible' } },
    },
    async ({ op, rule, request }) => {
      const p = opts.principal();
      if (p.origin === 'event') return json({ code: 'EVENT_ORIGIN', reason: 'rule changes must originate from a user request' }, true);
      return out(await store.propose({ op, rule: rule as Omit<Rule, 'version'>, request }, p));
    },
  );

  mcp.registerTool(
    'rules_backtest',
    { description: 'Replay a proposed change over recent history and return the impact report.', inputSchema: { changeId: z.string() }, annotations: { readOnlyHint: true }, _meta: meta },
    async ({ changeId }) => out(await store.backtest(changeId, await opts.history())),
  );

  mcp.registerTool(
    'rules_diff',
    { description: 'Show a proposed change against the live version.', inputSchema: { changeId: z.string() }, annotations: { readOnlyHint: true }, _meta: meta },
    ({ changeId }) => {
      const c = store.change(changeId);
      if (!c) return json({ code: 'NOT_FOUND' }, true);
      return json({ live: store.live().find((r) => r.id === c.rule.id) ?? null, proposed: c.op === 'retire' ? null : c.rule, tier: c.tier, tierReasons: c.tierReasons });
    },
  );

  mcp.registerTool(
    'rules_approve',
    { description: 'Approve a change (permitted humans only; enforced by tier).', inputSchema: { changeId: z.string(), fingerprint: z.string() }, _meta: { [EXT.actions]: { tier: 'reversible' } } },
    async ({ changeId, fingerprint }) => out(await store.approve(changeId, fingerprint, opts.principal())),
  );

  mcp.registerTool(
    'rules_deploy',
    { description: 'Deploy a change in shadow or live mode (atomic, versioned).', inputSchema: { changeId: z.string(), mode: z.enum(['shadow', 'live']) }, _meta: { [EXT.actions]: { tier: 'reversible' } } },
    async ({ changeId, mode }) => {
      if (opts.principal().origin === 'event') return json({ code: 'EVENT_ORIGIN' }, true);
      return out(await store.deploy(changeId, mode));
    },
  );

  mcp.registerTool(
    'rules_rollback',
    { description: 'Restore a previous rule version in one step.', inputSchema: { ruleId: z.string(), toVersion: z.number().int() }, _meta: { [EXT.actions]: { tier: 'reversible' } } },
    async ({ ruleId, toVersion }) => out(await store.rollback(ruleId, toVersion, opts.principal())),
  );

  mcp.registerTool(
    'rules_explain',
    { description: 'Why did (or didn\'t) an event wake the agent? Returns the decision trace with a sentence and a fix.', inputSchema: { eventId: z.string() }, annotations: { readOnlyHint: true }, _meta: meta },
    async ({ eventId }) => {
      const ds = await opts.decisions.forEvent(eventId);
      if (!ds.length) return json({ code: 'NOT_SEEN', sentence: 'This host never received the event.', fix: 'Check the subscription filter and the source with events/poll.' });
      return json({ decisions: ds.map((d) => ({ verdict: d.verdict, code: d.code, ...TRACE[d.code], reason: d.reason, rule: d.ruleId ? `${d.ruleId}@${d.ruleVersion}` : null, autonomy: d.autonomy, downgrades: d.downgrades, gates: d.gates })) });
    },
  );

  return mcp;
}
