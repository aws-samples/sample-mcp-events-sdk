import type { EventEnvelope, EventTypeDef } from '@agentevents/contract';
import type { Clock, RuntimeState } from './ports';
import type { TraceCode } from './trace';

/** Spec E3 §4.3: two independent axes. */
export type Verdict = 'drop' | 'store' | 'digest' | 'wake' | 'decide' | 'escalate';
export type Autonomy = 'notify' | 'investigate' | 'propose' | 'act';
export const AUTONOMY_ORDER: readonly Autonomy[] = ['notify', 'investigate', 'propose', 'act'];

export const minAutonomy = (a: Autonomy, b: Autonomy): Autonomy =>
  AUTONOMY_ORDER.indexOf(a) <= AUTONOMY_ORDER.indexOf(b) ? a : b;

export interface GateContext {
  event: EventEnvelope;
  def: EventTypeDef | undefined;
  clock: Clock;
  state: RuntimeState;
}

export interface GateOutcome {
  /** A decisive verdict ends the pipeline. Omit to only cap autonomy and continue. */
  verdict?: Verdict;
  autonomy?: Autonomy;
  /** Cap autonomy without deciding (e.g. emergency stop). Recorded as a downgrade. */
  autonomyCap?: Autonomy;
  code?: TraceCode;
  reason: string;
  ruleId?: string;
  ruleVersion?: number;
}

export interface Gate {
  id: string;
  version: string;
  stage: 'safety' | 'rule' | 'classifier';
  evaluate(ctx: GateContext): Promise<GateOutcome | undefined> | GateOutcome | undefined;
}

export interface GateTrace {
  gateId: string;
  gateVersion: string;
  outcome: GateOutcome | 'pass';
}

export interface Decision {
  eventId: string;
  type: string;
  subject: string | undefined;
  verdict: Verdict;
  autonomy: Autonomy;
  downgrades: { from: Autonomy; to: Autonomy; reason: string }[];
  code: TraceCode;
  reason: string;
  ruleId?: string;
  ruleVersion?: number;
  gates: GateTrace[];
  decidedAt: number;
}

export interface PipelineOptions {
  /** Used when no gate decides. `hint` = the server's suggested verdict (the host still decides). */
  defaultVerdict: 'store' | 'hint';
  defaultAutonomy: Autonomy;
}

const codeFor = (v: Verdict): TraceCode =>
  ({ drop: 'RULE_DROP', store: 'STORED', digest: 'DIGESTED', wake: 'WOKEN', decide: 'DECIDED', escalate: 'ESCALATED' })[v] as TraceCode;

/**
 * Spec E3 §4.2 gate pipeline. Safety gates run first and cannot be removed by rules; the first
 * decisive verdict wins; autonomy caps accumulate and are recorded as downgrades, never refusals.
 */
export class GatePipeline {
  constructor(
    private readonly safety: readonly Gate[],
    private readonly gates: () => readonly Gate[],
    private readonly opts: PipelineOptions,
  ) {}

  async decide(ctx: GateContext): Promise<Decision> {
    const traces: GateTrace[] = [];
    const caps: { cap: Autonomy; reason: string }[] = [];
    let decided: GateOutcome | undefined;

    for (const gate of [...this.safety.map((g) => assertStage(g, 'safety')), ...this.gates()]) {
      const out = await gate.evaluate(ctx);
      traces.push({ gateId: gate.id, gateVersion: gate.version, outcome: out ?? 'pass' });
      if (!out) continue;
      if (out.autonomyCap) caps.push({ cap: out.autonomyCap, reason: out.reason });
      if (out.verdict) {
        decided = out;
        break;
      }
    }

    const verdict: Verdict =
      decided?.verdict ??
      (this.opts.defaultVerdict === 'hint' ? (ctx.def?.hints?.suggestedVerdict ?? 'store') : 'store');
    let autonomy: Autonomy = decided?.autonomy ?? this.opts.defaultAutonomy;
    const downgrades: Decision['downgrades'] = [];
    for (const { cap, reason } of caps) {
      const next = minAutonomy(autonomy, cap);
      if (next !== autonomy) downgrades.push({ from: autonomy, to: next, reason });
      autonomy = next;
    }

    return {
      eventId: ctx.event.id,
      type: ctx.event.type,
      subject: ctx.event.subject,
      verdict,
      autonomy,
      downgrades,
      code: decided?.code ?? codeFor(verdict),
      reason: decided?.reason ?? 'no gate decided; default verdict',
      ...(decided?.ruleId ? { ruleId: decided.ruleId, ruleVersion: decided.ruleVersion } : {}),
      gates: traces,
      decidedAt: ctx.clock.now(),
    };
  }
}

function assertStage(g: Gate, stage: Gate['stage']): Gate {
  if (g.stage !== stage) throw new Error(`gate ${g.id} is not a ${stage} gate`);
  return g;
}

/** Decision records store (spec §7). Engine writes only; the LLM may read for explanation. */
export interface DecisionStore {
  put(d: Decision): Promise<void>;
  forEvent(eventId: string): Promise<Decision[]>;
  /** Most recent first. */
  recent(limit: number): Promise<Decision[]>;
}

export class MemoryDecisionStore implements DecisionStore {
  private readonly items: Decision[] = [];
  async put(d: Decision): Promise<void> {
    this.items.push(Object.freeze(structuredClone(d)));
  }
  async forEvent(eventId: string): Promise<Decision[]> {
    return this.items.filter((d) => d.eventId === eventId);
  }
  async recent(limit: number): Promise<Decision[]> {
    return this.items.slice(-limit).reverse();
  }
  /** Synchronous snapshot, for tests and demos. */
  all(): readonly Decision[] {
    return this.items;
  }
}
