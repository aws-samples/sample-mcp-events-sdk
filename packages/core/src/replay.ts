import type { EventEnvelope, SchemaRegistry } from '@agentevents/contract';
import type { Decision, GatePipeline, Verdict } from './gates';
import { MemoryRuntimeState, VirtualClock, type Clock, type RuntimeState } from './ports';

export type PipelineFactory = (deps: { clock: Clock; state: RuntimeState }) => GatePipeline;

export interface ImpactReport {
  total: number;
  verdicts: Record<Verdict, number>;
  byRule: Record<string, number>;
  examples: { eventId: string; subject: string | undefined; verdict: Verdict; reason: string }[];
  truncated: boolean;
}

export interface ReplayOptions {
  /** Simulate as if live, so rules are evaluated rather than short-circuited by the provenance gate. */
  asLive?: boolean;
  maxExamples?: number;
  maxEvents?: number;
}

/**
 * Deterministic replay (spec §8, roadmap 2). Fresh runtime state and a virtual clock pinned to each
 * event's receive time: the same log in gives the same decisions out. Never performs effects.
 */
export async function replay(
  events: readonly EventEnvelope[],
  factory: PipelineFactory,
  registry: SchemaRegistry,
  opts: ReplayOptions = {},
): Promise<{ decisions: Decision[]; report: ImpactReport }> {
  const max = opts.maxEvents ?? 50_000;
  const slice = events.slice(0, max);
  const clock = new VirtualClock(0);
  const state = new MemoryRuntimeState();
  const pipeline = factory({ clock, state });
  const decisions: Decision[] = [];
  for (const raw of slice) {
    const event = opts.asLive ? { ...raw, provenance: 'live' as const } : raw;
    clock.set(Date.parse(event.receivedat));
    decisions.push(await pipeline.decide({ event, def: registry.get(event.type), clock, state }));
  }
  return { decisions, report: summarize(decisions, events.length > max, opts.maxExamples ?? 5) };
}

export function summarize(decisions: readonly Decision[], truncated: boolean, maxExamples = 5): ImpactReport {
  const verdicts: Record<Verdict, number> = { drop: 0, store: 0, digest: 0, wake: 0, decide: 0, escalate: 0 };
  const byRule: Record<string, number> = {};
  const examples: ImpactReport['examples'] = [];
  for (const d of decisions) {
    verdicts[d.verdict] += 1;
    if (d.ruleId) byRule[`${d.ruleId}@${d.ruleVersion}`] = (byRule[`${d.ruleId}@${d.ruleVersion}`] ?? 0) + 1;
    if (examples.length < maxExamples) examples.push({ eventId: d.eventId, subject: d.subject, verdict: d.verdict, reason: d.reason });
  }
  return { total: decisions.length, verdicts, byRule, examples, truncated };
}

export interface ImpactDiff {
  changed: number;
  transitions: Record<string, number>;
  /** Events the live rules woke or escalated that the proposal would not. */
  newlySilenced: { eventId: string; subject: string | undefined; from: Verdict; to: Verdict }[];
  /** Events the proposal would wake that the live rules did not. */
  newlyWoken: { eventId: string; subject: string | undefined; from: Verdict; to: Verdict }[];
}

const LOUD: ReadonlySet<Verdict> = new Set(['wake', 'escalate', 'decide']);

export function diffDecisions(live: readonly Decision[], proposed: readonly Decision[]): ImpactDiff {
  const out: ImpactDiff = { changed: 0, transitions: {}, newlySilenced: [], newlyWoken: [] };
  for (let i = 0; i < Math.min(live.length, proposed.length); i++) {
    const a = live[i]!;
    const b = proposed[i]!;
    if (a.verdict === b.verdict) continue;
    out.changed += 1;
    const k = `${a.verdict}->${b.verdict}`;
    out.transitions[k] = (out.transitions[k] ?? 0) + 1;
    const row = { eventId: a.eventId, subject: a.subject, from: a.verdict, to: b.verdict };
    if (LOUD.has(a.verdict) && !LOUD.has(b.verdict)) out.newlySilenced.push(row);
    if (!LOUD.has(a.verdict) && LOUD.has(b.verdict)) out.newlyWoken.push(row);
  }
  return out;
}
