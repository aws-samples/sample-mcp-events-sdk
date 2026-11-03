import { deterministicId, getPath, sha256, type EventEnvelope, type SchemaRegistry, type SituationMeta } from '@agentevents/contract';

type Severity = SituationMeta['severity'];
const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export interface SituationConfig {
  inputType: string;
  outputType: string;
  outputSource: string;
  /** Paths that identify one situation, e.g. `['subject']`. */
  groupBy: string[];
  stateField: string;
  openStates: string[];
  resolveStates: string[];
  severityField?: string;
  defaultSeverity?: Severity;
  /** More than `flips` open/resolve transitions in the window → `flapping`, held open. */
  flapping?: { flips: number; windowSeconds: number };
  /** More than `openThreshold` openings in the window → one roll-up situation; members are quiet. */
  storm?: { openThreshold: number; windowSeconds: number; stormType: string };
}

interface KeyState {
  lifecycle: number;
  revision: number;
  open: boolean;
  lastId?: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  first: string[];
  last: string[];
  severity: Severity;
  transitions: number[];
  flapping: boolean;
  storm: boolean;
}

const EVIDENCE = 3;
const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/**
 * Spec E2: turns condition reports (ALARM/OK) into stateful situations (open/update/resolve).
 * Pure with respect to time: it only uses event timestamps, so replay gives identical output.
 */
export class SituationEngine {
  private readonly keys = new Map<string, KeyState>();
  private readonly opens: number[] = [];
  private stormState: { lifecycle: number; revision: number; open: boolean; members: Set<string> } = {
    lifecycle: 0,
    revision: 0,
    open: false,
    members: new Set(),
  };

  constructor(
    private readonly cfg: SituationConfig,
    private readonly registry: SchemaRegistry,
  ) {}

  process(ev: EventEnvelope): EventEnvelope[] {
    if (ev.type !== this.cfg.inputType) return [];
    const state = String(getPath(ev, this.cfg.stateField) ?? '');
    const isOpen = this.cfg.openStates.includes(state);
    const isResolve = this.cfg.resolveStates.includes(state);
    if (!isOpen && !isResolve) return [];

    const group = this.cfg.groupBy.map((p) => String(getPath(ev, p) ?? '')).join('|');
    const situationkey = `sha256:${sha256(`${ev.tenantid ?? ''}\u0000${this.cfg.outputType}\u0000${group}`)}`;
    const at = Date.parse(ev.time);
    const sev = this.severityOf(ev);
    const s = this.keys.get(situationkey);
    const out: EventEnvelope[] = [];

    if (isOpen) {
      if (!s || !s.open) {
        const next: KeyState = {
          lifecycle: (s?.lifecycle ?? 0) + 1,
          revision: 1,
          open: true,
          ...(s?.lastId ? { lastId: s.lastId } : {}),
          count: 1,
          firstSeenAt: ev.time,
          lastSeenAt: ev.time,
          first: [ev.id],
          last: [ev.id],
          severity: sev,
          transitions: [...(s?.transitions ?? []), at],
          flapping: false,
          storm: false,
        };
        next.flapping = this.isFlapping(next.transitions, at);
        next.storm = this.recordOpen(at);
        if (next.storm) {
          const roll = this.stormEvent(ev, situationkey);
          if (roll) out.push(roll);
        }
        this.keys.set(situationkey, next);
        out.push(this.emit(ev, situationkey, next, 'open', s?.lastId));
        return out;
      }
      const prevSeverity = s.severity;
      s.revision += 1;
      s.count += 1;
      s.lastSeenAt = ev.time;
      s.last = [...s.last, ev.id].slice(-EVIDENCE);
      if (s.first.length < EVIDENCE) s.first.push(ev.id);
      s.severity = SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(s.severity) ? sev : s.severity;
      const meaningful = s.severity !== prevSeverity || isPowerOfTwo(s.count);
      return meaningful ? [this.emit(ev, situationkey, s, 'update')] : [];
    }

    if (!s || !s.open) return [];
    s.transitions.push(at);
    s.flapping = this.isFlapping(s.transitions, at);
    s.lastSeenAt = ev.time;
    s.revision += 1;
    if (s.flapping) return [this.emit(ev, situationkey, s, 'update')];
    s.open = false;
    out.push(this.emit(ev, situationkey, s, 'resolve'));
    if (this.stormState.open) {
      this.stormState.members.delete(situationkey);
      if (this.stormState.members.size === 0 && this.cfg.storm) {
        this.stormState.open = false;
        this.stormState.revision += 1;
        out.push(this.stormEmit(ev, 'resolve', 0));
      }
    }
    return out;
  }

  private severityOf(ev: EventEnvelope): Severity {
    const v = this.cfg.severityField ? getPath(ev, this.cfg.severityField) : undefined;
    return SEVERITY_ORDER.includes(v as Severity) ? (v as Severity) : (this.cfg.defaultSeverity ?? 'medium');
  }

  private isFlapping(transitions: number[], at: number): boolean {
    const f = this.cfg.flapping;
    if (!f) return false;
    return transitions.filter((t) => t > at - f.windowSeconds * 1000).length > f.flips;
  }

  private recordOpen(at: number): boolean {
    const st = this.cfg.storm;
    if (!st) return false;
    this.opens.push(at);
    while (this.opens.length && this.opens[0]! <= at - st.windowSeconds * 1000) this.opens.shift();
    // Membership needs a burst inside the window; an open storm does not capture later, unrelated opens.
    return this.opens.length > st.openThreshold;
  }

  private stormEvent(ev: EventEnvelope, memberKey: string): EventEnvelope | undefined {
    this.stormState.members.add(memberKey);
    if (this.stormState.open) return undefined;
    // The members that opened before the threshold was crossed join the roll-up too.
    const windowStart = Date.parse(ev.time) - this.cfg.storm!.windowSeconds * 1000;
    for (const [k, st] of this.keys) if (st.open && Date.parse(st.firstSeenAt) > windowStart) this.stormState.members.add(k);
    this.stormState = { lifecycle: this.stormState.lifecycle + 1, revision: 1, open: true, members: this.stormState.members };
    return this.stormEmit(ev, 'open', this.opens.length);
  }

  private stormEmit(ev: EventEnvelope, transition: 'open' | 'resolve', opened: number): EventEnvelope {
    const st = this.cfg.storm!;
    const key = `sha256:${sha256(`${ev.tenantid ?? ''}\u0000${st.stormType}`)}`;
    const def = this.registry.get(st.stormType);
    if (!def) throw new Error(`storm type ${st.stormType} not registered`);
    return {
      specversion: '1.0',
      id: deterministicId(this.cfg.outputSource, `${key}#${this.stormState.lifecycle}#${this.stormState.revision}`),
      source: this.cfg.outputSource,
      type: st.stormType,
      time: ev.time,
      receivedat: ev.receivedat,
      dataschema: def.dataschema,
      subject: 'storm',
      partitionkey: key,
      provenance: ev.provenance,
      untrustedfields: [],
      ...(ev.tenantid ? { tenantid: ev.tenantid } : {}),
      data: { memberType: this.cfg.outputType, openedInWindow: opened, members: this.stormState.members.size },
      situation: {
        situationkey: key,
        transition,
        revision: this.stormState.revision,
        severity: 'high',
        occurrences: { count: this.stormState.members.size, firstSeenAt: ev.time, lastSeenAt: ev.time },
        evidence: { first: [], last: [] },
        flags: [],
      },
    };
  }

  private emit(ev: EventEnvelope, situationkey: string, s: KeyState, transition: SituationMeta['transition'], previousid?: string): EventEnvelope {
    const def = this.registry.get(this.cfg.outputType);
    if (!def) throw new Error(`situation type ${this.cfg.outputType} not registered`);
    const id = deterministicId(this.cfg.outputSource, `${situationkey}#${s.lifecycle}#${s.revision}`);
    s.lastId = id;
    const flags: SituationMeta['flags'] = [];
    if (s.flapping) flags.push('flapping');
    if (s.storm && transition !== 'resolve') flags.push('storm');
    return {
      specversion: '1.0',
      id,
      source: this.cfg.outputSource,
      type: this.cfg.outputType,
      time: ev.time,
      receivedat: ev.receivedat,
      dataschema: def.dataschema,
      partitionkey: situationkey,
      provenance: ev.provenance,
      untrustedfields: this.registry.untrustedPaths(this.cfg.outputType),
      correlationid: ev.correlationid ?? `sit-${situationkey.slice(7, 19)}-${s.lifecycle}`,
      ...(ev.subject ? { subject: ev.subject } : {}),
      ...(ev.causationid ? { causationid: ev.causationid } : {}),
      ...(ev.actor ? { actor: ev.actor } : {}),
      ...(ev.tenantid ? { tenantid: ev.tenantid } : {}),
      ...(ev.traceparent ? { traceparent: ev.traceparent } : {}),
      data: ev.data,
      situation: {
        situationkey,
        transition,
        revision: s.revision,
        ...(previousid ? { previousid } : {}),
        severity: s.severity,
        occurrences: { count: s.count, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt },
        evidence: { first: [...s.first], last: [...s.last] },
        flags,
      },
    };
  }
}
