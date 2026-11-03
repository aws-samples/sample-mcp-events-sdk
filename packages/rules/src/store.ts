import { randomUUID } from 'node:crypto';
import { sha256, type EventEnvelope, type SchemaRegistry } from '@agentevents/contract';
import {
  GatePipeline,
  diffDecisions,
  provenanceGate,
  replay,
  ruleGate,
  validateRule,
  type ImpactDiff,
  type ImpactReport,
  type Rule,
  type RuleIssue,
} from '@agentevents/core';
import { MemoryRuleLog, type RuleLog } from './persistence';

export type RiskTier = 'low' | 'medium' | 'high';

export interface Principal {
  id: string;
  roles: readonly string[];
  /** `event` = the request came from an event-triggered session. Such changes always need a human. */
  origin: 'user' | 'event';
}

export interface RuleVersion {
  rule: Rule;
  state: 'live' | 'shadow' | 'superseded' | 'retired';
  changeId: string;
  approvedBy: string;
  deployedAt: string;
}

export interface RuleChange {
  changeId: string;
  op: 'upsert' | 'retire';
  rule: Rule;
  request: { text: string; by: string; origin: Principal['origin'] };
  issues: RuleIssue[];
  tier: RiskTier;
  tierReasons: string[];
  fingerprint: string;
  backtest?: { report: ImpactReport; diff: ImpactDiff; window: { from: string; to: string; events: number } };
  shadowed: boolean;
  state: 'proposed' | 'approved' | 'rejected' | 'deployed';
  approvedBy?: string;
  createdAt: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };
const fail = (code: string, reason: string): { ok: false; code: string; reason: string } => ({ ok: false, code, reason });

/** Spec E5 risk tiers. Suppression is not automatically safe. */
export function classify(op: RuleChange['op'], rule: Rule, live: Rule | undefined): { tier: RiskTier; reasons: string[] } {
  const reasons: string[] = [];
  if (live?.mandatory || rule.mandatory) reasons.push('touches a mandatory rule');
  if (rule.verdict === 'decide' || rule.verdict === 'escalate' || live?.verdict === 'decide' || live?.verdict === 'escalate') reasons.push('changes decide/escalate verdicts');
  if (rule.autonomy === 'act') reasons.push('grants unattended action (act)');
  if ((rule.verdict === 'drop' || rule.verdict === 'store') && !rule.filter && !rule.window) reasons.push('suppresses an event type entirely');
  if (op === 'retire' && (live?.verdict === 'wake' || live?.verdict === 'escalate')) reasons.push('removes a rule that wakes or escalates');
  if (reasons.length) return { tier: 'high', reasons };
  if (rule.window) reasons.push('stateful threshold rule');
  if (rule.verdict === 'wake' || rule.verdict === 'drop') reasons.push(`${rule.verdict} rule`);
  if (reasons.length) return { tier: 'medium', reasons };
  return { tier: 'low', reasons: ['digest/store with a filter'] };
}

/**
 * Spec E5 rule store: versioned like code. Natural language is how a change is requested; what
 * runs is a validated, backtested, approved, versioned structured rule.
 */
export class RuleStore {
  private readonly versions = new Map<string, RuleVersion[]>();
  private readonly changes = new Map<string, RuleChange>();
  /** Policy: which tiers may be auto-approved (never for event-origin requests). */
  autoApprove: ReadonlySet<RiskTier> = new Set(['low']);
  adminRole = 'rule-admin';
  ownerRole = 'rule-owner';

  private constructor(
    private readonly registry: SchemaRegistry,
    private readonly now: () => number,
    private readonly log: RuleLog,
  ) {}

  /** Open a store and rebuild its state by replaying the log. */
  static async open(registry: SchemaRegistry, opts: { now?: () => number; log?: RuleLog } = {}): Promise<RuleStore> {
    const store = new RuleStore(registry, opts.now ?? Date.now, opts.log ?? new MemoryRuleLog());
    for (const rec of await store.log.load()) {
      if (rec.kind === 'versions') store.versions.set(rec.ruleId, rec.versions);
      else store.changes.set(rec.change.changeId, rec.change);
    }
    return store;
  }

  private saveRule(ruleId: string): Promise<void> {
    return this.log.append({ kind: 'versions', at: new Date(this.now()).toISOString(), ruleId, versions: this.versions.get(ruleId) ?? [] });
  }

  private saveChange(c: RuleChange): Promise<void> {
    return this.log.append({ kind: 'change', at: new Date(this.now()).toISOString(), change: c });
  }

  /** Seed rules directly (bootstrap, or an admin's mandatory baseline). */
  async seed(rule: Rule, by: string): Promise<void> {
    if (this.versions.has(rule.id)) return; // already persisted
    await this.push(rule.id, { rule, state: 'live', changeId: 'seed', approvedBy: by, deployedAt: new Date(this.now()).toISOString() });
  }

  live(): Rule[] {
    return [...this.versions.values()].flatMap((vs) => vs.filter((v) => v.state === 'live').map((v) => v.rule));
  }

  shadow(): Rule[] {
    return [...this.versions.values()].flatMap((vs) => vs.filter((v) => v.state === 'shadow').map((v) => v.rule));
  }

  history(ruleId: string): RuleVersion[] {
    return [...(this.versions.get(ruleId) ?? [])];
  }

  change(id: string): RuleChange | undefined {
    return this.changes.get(id);
  }

  async propose(input: { op: RuleChange['op']; rule: Omit<Rule, 'version'>; request: string }, by: Principal): Promise<Result<RuleChange>> {
    if (!input.request.trim()) return fail('NO_REQUEST', 'attach the original request');
    const live = this.liveVersion(input.rule.id);
    const version = (this.versions.get(input.rule.id)?.at(-1)?.rule.version ?? 0) + 1;
    const rule: Rule = { ...input.rule, version };
    if (live?.rule.mandatory && !by.roles.includes(this.adminRole)) {
      return fail('MANDATORY', `${rule.id} is mandatory; only ${this.adminRole} may change it`);
    }
    if (input.op === 'retire' && !live) return fail('NOT_FOUND', `no live rule ${rule.id}`);
    const issues = input.op === 'upsert' ? validateRule(rule, this.registry) : [];
    const { tier, reasons } = classify(input.op, rule, live?.rule);
    const change: RuleChange = {
      changeId: `chg_${randomUUID()}`,
      op: input.op,
      rule,
      request: { text: input.request, by: by.id, origin: by.origin },
      issues,
      tier,
      tierReasons: reasons,
      fingerprint: `sha256:${sha256(JSON.stringify([input.op, rule]))}`,
      shadowed: false,
      state: issues.length ? 'rejected' : 'proposed',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.changes.set(change.changeId, change);
    await this.saveChange(change);
    return { ok: true, value: change };
  }

  /** Replay the proposal against recent history; the impact report is what gets approved. */
  async backtest(changeId: string, history: readonly EventEnvelope[]): Promise<Result<RuleChange>> {
    const c = this.changes.get(changeId);
    if (!c) return fail('NOT_FOUND', 'no such change');
    if (c.state === 'rejected') return fail('INVALID', 'fix validation issues first');
    const current = this.live();
    const proposed = c.op === 'retire' ? current.filter((r) => r.id !== c.rule.id) : [...current.filter((r) => r.id !== c.rule.id), c.rule];
    const mk = (rules: Rule[]) => () => new GatePipeline([provenanceGate()], () => [ruleGate(() => rules)], { defaultVerdict: 'store', defaultAutonomy: 'investigate' });
    const a = await replay(history, mk(current), this.registry, { asLive: true });
    const b = await replay(history, mk(proposed), this.registry, { asLive: true });
    c.backtest = {
      report: b.report,
      diff: diffDecisions(a.decisions, b.decisions),
      window: { from: history[0]?.time ?? '', to: history.at(-1)?.time ?? '', events: history.length },
    };
    await this.saveChange(c);
    return { ok: true, value: c };
  }

  async approve(changeId: string, fingerprint: string, by: Principal): Promise<Result<RuleChange>> {
    const c = this.changes.get(changeId);
    if (!c) return fail('NOT_FOUND', 'no such change');
    if (c.state !== 'proposed') return fail('STATE', `change is ${c.state}`);
    if (c.fingerprint !== fingerprint) return fail('FINGERPRINT_MISMATCH', 'the change differs from what was reviewed');
    if (!c.backtest) return fail('NO_BACKTEST', 'run rules_backtest first; approve the impact report, not the wording');
    if (by.origin === 'event') return fail('EVENT_ORIGIN', 'approvals cannot come from an event-triggered session');
    const eventOrigin = c.request.origin === 'event';
    switch (c.tier) {
      case 'low':
        if (!eventOrigin && by.id === c.request.by && this.autoApprove.has('low')) break;
        if (!by.roles.includes(this.ownerRole) && !by.roles.includes(this.adminRole)) return fail('APPROVER', 'needs rule-owner approval');
        break;
      case 'medium':
        if (!by.roles.includes(this.ownerRole) && !by.roles.includes(this.adminRole)) return fail('APPROVER', 'medium tier needs rule-owner approval');
        break;
      case 'high':
        if (!by.roles.includes(this.adminRole)) return fail('APPROVER', `high tier needs a named ${this.adminRole}`);
        if (by.id === c.request.by) return fail('APPROVER', 'high tier needs an approver other than the requester');
        if (!c.shadowed) return fail('NO_SHADOW', 'high tier must run in shadow mode before approval');
        break;
    }
    c.state = 'approved';
    c.approvedBy = by.id;
    await this.saveChange(c);
    return { ok: true, value: c };
  }

  /** Atomic deploy. `shadow` runs alongside live without effect; `live` requires approval. */
  async deploy(changeId: string, mode: 'shadow' | 'live'): Promise<Result<RuleVersion | undefined>> {
    const c = this.changes.get(changeId);
    if (!c) return fail('NOT_FOUND', 'no such change');
    const at = new Date(this.now()).toISOString();
    if (mode === 'shadow') {
      if (c.state === 'rejected') return fail('INVALID', 'invalid change');
      c.shadowed = true;
      const v: RuleVersion = { rule: c.rule, state: 'shadow', changeId, approvedBy: 'shadow', deployedAt: at };
      await this.push(c.rule.id, v);
      await this.saveChange(c);
      return { ok: true, value: v };
    }
    if (c.state !== 'approved') return fail('NOT_APPROVED', 'approve before deploying live');
    for (const v of this.versions.get(c.rule.id) ?? []) if (v.state === 'live' || v.state === 'shadow') v.state = 'superseded';
    c.state = 'deployed';
    if (c.op === 'retire') {
      const last = this.versions.get(c.rule.id)?.at(-1);
      if (last) last.state = 'retired';
      await this.saveRule(c.rule.id);
      await this.saveChange(c);
      return { ok: true, value: undefined };
    }
    const v: RuleVersion = { rule: c.rule, state: 'live', changeId, approvedBy: c.approvedBy ?? '', deployedAt: at };
    await this.push(c.rule.id, v);
    await this.saveChange(c);
    return { ok: true, value: v };
  }

  /** One-step rollback to a previous version (as a new version, so history stays append-only). */
  async rollback(ruleId: string, toVersion: number, by: Principal): Promise<Result<RuleVersion>> {
    if (by.origin === 'event') return fail('EVENT_ORIGIN', 'rollbacks cannot come from an event-triggered session');
    const vs = this.versions.get(ruleId);
    const target = vs?.find((v) => v.rule.version === toVersion);
    if (!vs || !target) return fail('NOT_FOUND', `no version ${toVersion} of ${ruleId}`);
    if (target.rule.mandatory || vs.some((v) => v.state === 'live' && v.rule.mandatory)) {
      if (!by.roles.includes(this.adminRole)) return fail('MANDATORY', 'mandatory rule');
    }
    // A rollback is a rule change: classify what it would restore against what is live now.
    const { tier, reasons } = classify('upsert', target.rule, this.liveVersion(ruleId)?.rule);
    if (!by.roles.includes(this.ownerRole) && !by.roles.includes(this.adminRole)) {
      return fail('APPROVER', `rollback needs ${this.ownerRole} or ${this.adminRole}`);
    }
    if (tier === 'high') {
      // High-tier changes need a backtest, shadow mode and a separate named approver, which a
      // one-step rollback cannot provide: restore the version through rules_propose instead.
      return fail('HIGH_TIER', `restoring v${toVersion} is high risk (${reasons.join('; ')}); propose it as a change`);
    }
    for (const v of vs) if (v.state === 'live') v.state = 'superseded';
    const next: RuleVersion = {
      rule: { ...target.rule, version: (vs.at(-1)?.rule.version ?? 0) + 1 },
      state: 'live',
      changeId: `rollback:${toVersion}`,
      approvedBy: by.id,
      deployedAt: new Date(this.now()).toISOString(),
    };
    vs.push(next);
    await this.saveRule(ruleId);
    return { ok: true, value: next };
  }

  private liveVersion(id: string): RuleVersion | undefined {
    return this.versions.get(id)?.find((v) => v.state === 'live');
  }

  private async push(id: string, v: RuleVersion): Promise<void> {
    const list = this.versions.get(id) ?? [];
    list.push(v);
    this.versions.set(id, list);
    await this.saveRule(id);
  }
}
