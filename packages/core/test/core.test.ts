import { describe, expect, it } from 'vitest';
import { SchemaRegistry, type EventTypeDef, Autonomy, Provenance, Severity, Transition, Verdict, FilterLanguage } from '@agentevents/contract';
import {
  GatePipeline,
  MemoryRuntimeState,
  SituationEngine,
  VirtualClock,
  diffDecisions,
  emergencyStopGate,
  expiryGate,
  loopGate,
  provenanceGate,
  quietGate,
  replay,
  ruleGate,
  validateRule,
  type Gate,
  type Rule,
} from '@agentevents/core';
import { makeEvent } from '@agentevents/testkit';

const alarmSchema = {
  type: 'object',
  properties: {
    alarm: { type: 'string', 'x-event': { filterable: true } },
    state: { type: 'string', enum: ['ALARM', 'OK'], 'x-event': { filterable: true } },
    env: { type: 'string', 'x-event': { filterable: true } },
    severity: { type: 'string', 'x-event': { filterable: true } },
  },
};
const raw: EventTypeDef = { type: 'com.example.ops.alarm_state.v1', version: '1.0.0', title: 'raw', dataschema: 'https://s.example.com/raw/1.json', schema: alarmSchema };
const sit: EventTypeDef = { type: 'com.example.ops.alarm.v1', version: '1.0.0', title: 'situation', dataschema: 'https://s.example.com/sit/1.json', schema: alarmSchema, situation: true };
const storm: EventTypeDef = { type: 'com.example.ops.alarm_storm.v1', version: '1.0.0', title: 'storm', dataschema: 'https://s.example.com/storm/1.json', schema: { type: 'object', properties: {} }, situation: true };

const reg = (): SchemaRegistry => {
  const r = new SchemaRegistry();
  [raw, sit, storm].forEach((d) => r.register(d));
  return r;
};

const at = (min: number): string => new Date(Date.UTC(2026, 10, 2, 10, min)).toISOString();
const alarm = (subject: string, state: 'ALARM' | 'OK', min: number, extra: Record<string, unknown> = {}) =>
  makeEvent(raw, { alarm: subject, state, env: 'prod', severity: Severity.High, ...extra }, { subject, time: at(min), receivedat: at(min) });

describe('situations', () => {
  const engine = (over = {}) =>
    new SituationEngine(
      { inputType: raw.type, outputType: sit.type, outputSource: 'ops.example.com', groupBy: ['subject'], stateField: 'data.state', openStates: ['ALARM'], resolveStates: ['OK'], severityField: 'data.severity', ...over },
      reg(),
    );

  it('opens, suppresses non-meaningful updates, resolves and reopens with previousid', () => {
    const e = engine();
    const [open] = e.process(alarm('cpu', 'ALARM', 0));
    expect(open?.situation).toMatchObject({ transition: Transition.Open, revision: 1 });
    expect(e.process(alarm('cpu', 'ALARM', 1))[0]?.situation).toMatchObject({ transition: Transition.Update, occurrences: { count: 2 } });
    expect(e.process(alarm('cpu', 'ALARM', 2))).toHaveLength(0); // count 3: not a power of two
    const [res] = e.process(alarm('cpu', 'OK', 3));
    expect(res?.situation?.transition).toBe(Transition.Resolve);
    const [reopen] = e.process(alarm('cpu', 'ALARM', 30));
    expect(reopen?.situation).toMatchObject({ transition: Transition.Open, previousid: res?.id });
    expect(reopen?.id).not.toBe(open?.id);
  });

  it('holds a flapping situation open', () => {
    const e = engine({ flapping: { flips: 3, windowSeconds: 600 } });
    e.process(alarm('disk', 'ALARM', 0));
    e.process(alarm('disk', 'OK', 1));
    e.process(alarm('disk', 'ALARM', 2));
    const [held] = e.process(alarm('disk', 'OK', 3));
    expect(held?.situation).toMatchObject({ transition: Transition.Update, flags: ['flapping'] });
  });

  it('rolls a storm into one situation and flags members', () => {
    const e = engine({ storm: { openThreshold: 3, windowSeconds: 300, stormType: storm.type } });
    const out = ['a', 'b', 'c', 'd', 'e'].flatMap((s, i) => e.process(alarm(s, 'ALARM', i % 2)));
    const rolls = out.filter((o) => o.type === storm.type);
    expect(rolls).toHaveLength(1);
    expect(out.filter((o) => o.situation?.flags.includes('storm')).map((o) => o.subject)).toEqual(['d', 'e']);
  });
});

describe('gate pipeline', () => {
  const pipeline = (rules: Rule[], extra: Gate[] = [], stopped = false) =>
    new GatePipeline(
      [provenanceGate(), expiryGate({ stalenessMs: 3_600_000 }), loopGate({ causedByUs: (id) => id === 'act-1' }), quietGate(), emergencyStopGate({ state: () => (stopped ? 'stopped' : 'running') }), ...extra],
      () => [ruleGate(() => rules)],
      { defaultVerdict: Verdict.Store, defaultAutonomy: Autonomy.Investigate },
    );
  const ctx = (event = alarm('cpu', 'ALARM', 0)) => ({ event, def: raw, clock: new VirtualClock(Date.parse(event.time)), state: new MemoryRuntimeState() });
  const wakeProd: Rule = { id: 'wake-prod', version: 1, description: 'wake on prod alarms', types: [raw.type], filter: { language: FilterLanguage.EbPattern, expression: { 'data.env': ['prod'], 'data.state': ['ALARM'] } }, verdict: Verdict.Wake, autonomy: Autonomy.Propose };

  it('rules decide; replay provenance never wakes', async () => {
    expect((await pipeline([wakeProd]).decide(ctx())).verdict).toBe(Verdict.Wake);
    const d = await pipeline([wakeProd]).decide(ctx({ ...alarm('cpu', 'ALARM', 0), provenance: Provenance.Replay }));
    expect(d).toMatchObject({ verdict: Verdict.Store, code: 'NOT_LIVE' });
  });

  it('detects loops by actor identity and by causation id', async () => {
    const byPlatform = { ...alarm('cpu', 'ALARM', 0), actor: { kind: 'platform' as const, principal: 'agent-role' } };
    expect((await pipeline([wakeProd]).decide(ctx(byPlatform))).code).toBe('LOOP');
    expect((await pipeline([wakeProd]).decide(ctx({ ...alarm('cpu', 'ALARM', 0), causationid: 'act-1' }))).code).toBe('LOOP');
  });

  it('emergency stop downgrades autonomy (recorded), and fails closed when unreadable', async () => {
    const d = await pipeline([wakeProd], [], true).decide(ctx());
    expect(d).toMatchObject({ verdict: Verdict.Wake, autonomy: Autonomy.Notify, downgrades: [{ from: Autonomy.Propose, to: Autonomy.Notify }] });
    const broken = new GatePipeline([emergencyStopGate({ state: () => { throw new Error('ssm down'); } })], () => [ruleGate(() => [wakeProd])], { defaultVerdict: Verdict.Store, defaultAutonomy: Autonomy.Investigate });
    expect((await broken.decide(ctx())).autonomy).toBe(Autonomy.Notify);
  });

  it('records every gate in the decision trace', async () => {
    const d = await pipeline([wakeProd]).decide(ctx());
    expect(d.gates.map((g) => g.gateId)).toEqual(['safety.provenance', 'safety.expiry', 'safety.loop', 'safety.quiet', 'safety.emergency-stop', 'rules']);
    expect(d.ruleId).toBe('wake-prod');
  });

  it('threshold rules wake only on the Nth event in the window', async () => {
    const r: Rule = { id: 'third', version: 1, description: '3 in 10 min', types: [raw.type], window: { operator: 'threshold', count: 3, windowSeconds: 600, by: 'subject' }, verdict: Verdict.Wake };
    const p = pipeline([r]);
    const state = new MemoryRuntimeState();
    const verdicts = [];
    for (const m of [0, 2, 4]) {
      const event = alarm('cpu', 'ALARM', m);
      verdicts.push((await p.decide({ event, def: raw, clock: new VirtualClock(Date.parse(event.time)), state })).verdict);
    }
    expect(verdicts).toEqual([Verdict.Store, Verdict.Store, Verdict.Wake]);
  });

  it('validates rules against the schema', () => {
    const issues = validateRule({ ...wakeProd, filter: { language: FilterLanguage.EbPattern, expression: { 'data.enviroment': ['prod'] } } }, reg());
    expect(issues[0]?.reason).toMatch(/unknown field/u);
  });
});

describe('replay', () => {
  it('is deterministic and diffs a proposal against live rules', async () => {
    const r = reg();
    const events = [alarm('cpu', 'ALARM', 0), alarm('cpu', 'ALARM', 1, { env: 'staging' }), alarm('disk', 'ALARM', 2, { env: 'staging' })];
    const live: Rule[] = [{ id: 'wake-all', version: 1, description: 'wake on alarms', types: [raw.type], verdict: Verdict.Wake }];
    const proposed: Rule[] = [{ id: 'mute-staging', version: 1, description: 'store staging', types: [raw.type], filter: { language: FilterLanguage.EbPattern, expression: { 'data.env': ['staging'] } }, verdict: Verdict.Store }, ...live];
    const mk = (rules: Rule[]) => () => new GatePipeline([provenanceGate()], () => [ruleGate(() => rules)], { defaultVerdict: Verdict.Store, defaultAutonomy: Autonomy.Investigate });
    const a = await replay(events, mk(live), r, { asLive: true });
    const a2 = await replay(events, mk(live), r, { asLive: true });
    expect(a.decisions.map((d) => d.verdict)).toEqual(a2.decisions.map((d) => d.verdict));
    const b = await replay(events, mk(proposed), r, { asLive: true });
    const diff = diffDecisions(a.decisions, b.decisions);
    expect(diff.newlySilenced).toHaveLength(2);
    expect(b.report.verdicts).toMatchObject({ wake: 1, store: 2 });
  });
});
