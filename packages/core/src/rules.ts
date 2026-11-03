import { evaluateFilter, getPath, validateFilter, type FilterSpec, type SchemaRegistry, Autonomy, Verdict } from '@agentevents/contract';
import type { Gate } from './gates';

import { GateStage } from './gates';
/**
 * A rule is structured and deterministic (spec E5): never prose. Rules live in the rule store and
 * change only through its lifecycle.
 */
export interface Rule {
  id: string;
  version: number;
  description: string;
  /** Event types the rule applies to. */
  types: string[];
  filter?: FilterSpec;
  /** Spec E2 §3.3 `threshold` operator: match only when `count` events share `by` within the window. */
  window?: { operator: 'threshold'; count: number; windowSeconds: number; by: string };
  verdict: Verdict;
  autonomy?: Autonomy;
  /** Set by an admin; users cannot weaken it. Mandatory rules are evaluated first. */
  mandatory?: boolean;
  /** Lower runs first (after mandatory rules). Default 100. First match wins. */
  priority?: number;
}

export interface RuleIssue {
  path: string;
  reason: string;
}

export function validateRule(rule: Rule, registry: SchemaRegistry): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!rule.types.length) issues.push({ path: 'types', reason: 'at least one event type is required' });
  for (const t of rule.types) if (!registry.get(t)) issues.push({ path: 'types', reason: `unknown event type ${t}` });
  if (rule.filter) {
    const v = validateFilter(rule.filter, registry, rule.types.filter((t) => registry.get(t)));
    if (!v.ok) issues.push(...v.issues.map((i) => ({ path: `filter.${i.path}`, reason: i.reason })));
  }
  if (rule.window) {
    if (rule.window.count < 1 || rule.window.windowSeconds < 1) issues.push({ path: 'window', reason: 'count and windowSeconds must be >= 1' });
    const by = rule.window.by;
    if (by !== 'subject' && by !== 'source') {
      for (const t of rule.types) if (!registry.fields(t).get(by)) issues.push({ path: 'window.by', reason: `unknown field ${by} in ${t}` });
    }
  }
  if (rule.autonomy && !([Verdict.Wake, Verdict.Escalate] as Verdict[]).includes(rule.verdict)) {
    issues.push({ path: 'autonomy', reason: 'autonomy only applies to wake or escalate verdicts' });
  }
  return issues;
}

/** Evaluates the active rule set, mandatory rules first, first match wins. */
export function ruleGate(activeRules: () => readonly Rule[]): Gate {
  return {
    id: 'rules',
    version: '1',
    stage: GateStage.Rule,
    evaluate: async ({ event, state }) => {
      const rules = [...activeRules()].sort(
        (a, b) => Number(!!b.mandatory) - Number(!!a.mandatory) || (a.priority ?? 100) - (b.priority ?? 100),
      );
      for (const r of rules) {
        if (!r.types.includes(event.type)) continue;
        if (r.filter && !(await evaluateFilter(r.filter, event)).match) continue;
        if (r.window) {
          const key = String(getPath(event, r.window.by) ?? '');
          const n = await state.countInWindow(`rule:${r.id}@${r.version}`, key, Date.parse(event.time), r.window.windowSeconds * 1000);
          if (n < r.window.count) continue;
        }
        return {
          verdict: r.verdict,
          ...(r.autonomy ? { autonomy: r.autonomy } : {}),
          reason: `rule ${r.id}@${r.version}: ${r.description}`,
          ruleId: r.id,
          ruleVersion: r.version,
        };
      }
      return undefined;
    },
  };
}
