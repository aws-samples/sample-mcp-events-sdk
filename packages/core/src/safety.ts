import type { EventEnvelope } from '@agentevents/contract';
import type { Gate } from './gates';

import { Autonomy, Provenance, Verdict } from '@agentevents/contract';
import { GateStage } from './gates';
/** Spec E3 §4.2 step 2: mandatory safety gates. Rules cannot disable these. */

export function provenanceGate(): Gate {
  return {
    id: 'safety.provenance',
    version: '1',
    stage: GateStage.Safety,
    evaluate: ({ event }) =>
      event.provenance === Provenance.Live || event.provenance === Provenance.Redrive
        ? undefined
        : { verdict: Verdict.Store, code: 'NOT_LIVE', reason: `provenance ${event.provenance} never wakes or decides` },
  };
}

export function expiryGate(opts: { stalenessMs: number }): Gate {
  return {
    id: 'safety.expiry',
    version: '1',
    stage: GateStage.Safety,
    evaluate: ({ event, clock }) => {
      const now = clock.now();
      if (event.expiresat && Date.parse(event.expiresat) <= now) {
        return { verdict: Verdict.Store, code: 'EXPIRED', reason: `expired at ${event.expiresat}` };
      }
      const lag = now - Date.parse(event.time);
      if (lag > opts.stalenessMs) {
        return { verdict: Verdict.Store, code: 'EXPIRED', reason: `arrived ${Math.round(lag / 1000)}s after it happened` };
      }
      return undefined;
    },
  };
}

export interface LoopGateOptions {
  /** True when `causationid` names an action this host (or its agents) performed. */
  causedByUs: (causationId: string) => boolean;
  /** Max agent actions per correlation id before further events are not acted on. */
  maxActionsPerCorrelation?: number;
  actionsInCorrelation?: (correlationId: string) => number;
}

/** Loop detection by causation id AND by actor identity (spec E1 §2.6, gap A16). */
export function loopGate(opts: LoopGateOptions): Gate {
  return {
    id: 'safety.loop',
    version: '1',
    stage: GateStage.Safety,
    evaluate: ({ event }) => {
      if (event.actor?.kind === 'platform') {
        return { verdict: Verdict.Store, code: 'LOOP', reason: `caused by platform principal ${event.actor.principal ?? ''}`.trim() };
      }
      if (event.causationid && opts.causedByUs(event.causationid)) {
        return { verdict: Verdict.Store, code: 'LOOP', reason: `caused by our action ${event.causationid}` };
      }
      const max = opts.maxActionsPerCorrelation;
      if (max !== undefined && event.correlationid && (opts.actionsInCorrelation?.(event.correlationid) ?? 0) >= max) {
        return { verdict: Verdict.Store, code: 'LOOP', reason: `correlation ${event.correlationid} reached ${max} agent actions` };
      }
      return undefined;
    },
  };
}

/** Situations flagged suppressed, flapping or storm members are quiet (spec E2 §3.2). */
export function quietGate(): Gate {
  return {
    id: 'safety.quiet',
    version: '1',
    stage: GateStage.Safety,
    evaluate: ({ event }) => {
      const flags = event.situation?.flags ?? [];
      const quiet = flags.filter((f) => f === 'suppressed' || f === 'storm' || f === 'flapping');
      return quiet.length ? { verdict: Verdict.Store, code: 'QUIET', reason: `situation is ${quiet.join(', ')}` } : undefined;
    },
  };
}

export interface EmergencyStop {
  /** Throwing or returning undefined is treated as STOPPED (fail closed). */
  state(tenantid: string | undefined): Promise<'running' | 'stopped' | undefined> | 'running' | 'stopped' | undefined;
}

/** Spec E3 §4.8: notifications continue, acting stops. Implemented as an autonomy cap. */
export function emergencyStopGate(stop: EmergencyStop): Gate {
  return {
    id: 'safety.emergency-stop',
    version: '1',
    stage: GateStage.Safety,
    evaluate: async ({ event }) => {
      let s: 'running' | 'stopped' | undefined;
      try {
        s = await stop.state(event.tenantid);
      } catch {
        s = undefined;
      }
      return s === 'running' ? undefined : { autonomyCap: Autonomy.Notify, reason: s ? 'emergency stop active' : 'emergency stop state unreadable (fail closed)' };
    },
  };
}

/** Layer-3 semantic dedup on `dedupkey` (spec E1 §2.6). */
export function semanticDedupGate(opts: { windowMs: number }): Gate {
  return {
    id: 'safety.dedup-l3',
    version: '1',
    stage: GateStage.Safety,
    evaluate: async ({ event, state, clock }) => {
      if (!event.dedupkey) return undefined;
      return (await state.seen('L3', `${event.tenantid ?? ''}\u0000${event.dedupkey}`, opts.windowMs, clock.now()))
        ? { verdict: Verdict.Drop, code: 'DEDUPED_L3', reason: `dedupkey ${event.dedupkey} seen within window` }
        : undefined;
    },
  };
}

export const isLive = (ev: EventEnvelope): boolean => ev.provenance === Provenance.Live || ev.provenance === Provenance.Redrive;
