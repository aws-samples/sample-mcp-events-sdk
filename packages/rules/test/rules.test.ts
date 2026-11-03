import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaRegistry, type EventTypeDef } from '@agentevents/contract';
import type { Rule } from '@agentevents/core';
import { FileRuleLog, RuleStore, classify, type Principal } from '@agentevents/rules';
import { makeEvent } from '@agentevents/testkit';

const def: EventTypeDef = {
  type: 'com.example.ops.alarm.v1',
  version: '1.0.0',
  title: 'alarm',
  dataschema: 'https://s.example.com/a/1.json',
  schema: { type: 'object', properties: { env: { type: 'string', 'x-event': { filterable: true } }, severity: { type: 'string', 'x-event': { filterable: true } } } },
};
const reg = (): SchemaRegistry => {
  const r = new SchemaRegistry();
  r.register(def);
  return r;
};
const user: Principal = { id: 'pat', roles: ['rule-owner'], origin: 'user' };
const admin: Principal = { id: 'sam', roles: ['rule-admin'], origin: 'user' };
const wakeAll: Rule = { id: 'wake-all', version: 1, description: 'wake on alarms', types: [def.type], verdict: 'wake' };
const history = ['prod', 'staging', 'staging'].map((env, i) =>
  makeEvent(def, { env, severity: 'low' }, { subject: `svc-${i}`, time: `2026-11-02T10:0${i}:00.000Z`, receivedat: `2026-11-02T10:0${i}:00.000Z` }),
);
const muteStaging = { id: 'mute-staging', description: 'store staging alarms', types: [def.type], filter: { language: 'eb-pattern' as const, expression: { 'data.env': ['staging'] } }, verdict: 'store' as const, priority: 10 };

describe('rule lifecycle', () => {
  it('classifies risk: suppression of a whole type is high', () => {
    expect(classify('upsert', { ...wakeAll, verdict: 'store' }, undefined).tier).toBe('high');
    expect(classify('upsert', { ...muteStaging, version: 1 }, undefined).tier).toBe('low');
    expect(classify('upsert', { ...wakeAll, autonomy: 'act' }, undefined).tier).toBe('high');
  });

  it('rejects invalid rules, requires a backtest, then deploys and rolls back', async () => {
    const store = await RuleStore.open(reg());
    await store.seed(wakeAll, 'bootstrap');
    const bad = await store.propose({ op: 'upsert', rule: { ...muteStaging, filter: { language: 'eb-pattern', expression: { 'data.enviroment': ['staging'] } } }, request: 'mute staging' }, user);
    expect(bad.ok && bad.value.state).toBe('rejected');

    const p = await store.propose({ op: 'upsert', rule: muteStaging, request: 'stop waking me for staging alarms' }, user);
    if (!p.ok) throw new Error(p.reason);
    expect(await store.approve(p.value.changeId, p.value.fingerprint, user)).toMatchObject({ ok: false, code: 'NO_BACKTEST' });
    const bt = await store.backtest(p.value.changeId, history);
    if (!bt.ok) throw new Error(bt.reason);
    expect(bt.value.backtest?.diff.newlySilenced).toHaveLength(2);
    expect(await store.approve(p.value.changeId, 'sha256:wrong', user)).toMatchObject({ ok: false, code: 'FINGERPRINT_MISMATCH' });
    expect((await store.approve(p.value.changeId, p.value.fingerprint, user)).ok).toBe(true);
    expect((await store.deploy(p.value.changeId, 'live')).ok).toBe(true);
    expect(store.live().map((r) => r.id).sort()).toEqual(['mute-staging', 'wake-all']);

    const rb = await store.rollback('wake-all', 1, user);
    expect(rb.ok && rb.value.rule.version).toBe(2);
  });

  it('refuses event-origin approvals and enforces high-tier rules', async () => {
    const store = await RuleStore.open(reg());
    await store.seed(wakeAll, 'bootstrap');
    const p = await store.propose({ op: 'retire', rule: wakeAll, request: 'stop all alarm wakes' }, user);
    if (!p.ok) throw new Error(p.reason);
    expect(p.value.tier).toBe('high');
    await store.backtest(p.value.changeId, history);
    expect(await store.approve(p.value.changeId, p.value.fingerprint, { ...admin, origin: 'event' })).toMatchObject({ code: 'EVENT_ORIGIN' });
    expect(await store.approve(p.value.changeId, p.value.fingerprint, user)).toMatchObject({ code: 'APPROVER' });
    expect(await store.approve(p.value.changeId, p.value.fingerprint, admin)).toMatchObject({ code: 'NO_SHADOW' });
    await store.deploy(p.value.changeId, 'shadow');
    expect((await store.approve(p.value.changeId, p.value.fingerprint, admin)).ok).toBe(true);
  });

  it('rollback follows risk tiers: needs a role, and high-risk versions must be proposed', async () => {
    const store = await RuleStore.open(reg());
    await store.seed({ ...wakeAll, autonomy: 'act' }, 'bootstrap'); // v1: high risk (unattended action)
    const p = await store.propose({ op: 'upsert', rule: { ...wakeAll, autonomy: 'investigate' }, request: 'investigate only' }, user);
    if (!p.ok) throw new Error(p.reason);
    await store.backtest(p.value.changeId, history);
    await store.approve(p.value.changeId, p.value.fingerprint, user);
    await store.deploy(p.value.changeId, 'live');
    expect(await store.rollback('wake-all', 1, { id: 'eve', roles: [], origin: 'user' })).toMatchObject({ ok: false, code: 'APPROVER' });
    expect(await store.rollback('wake-all', 1, admin)).toMatchObject({ ok: false, code: 'HIGH_TIER' });
    expect(store.live()[0]?.autonomy).toBe('investigate');
  });

  it('protects mandatory rules', async () => {
    const store = await RuleStore.open(reg());
    await store.seed({ ...wakeAll, mandatory: true }, 'admin');
    expect(await store.propose({ op: 'retire', rule: wakeAll, request: 'remove' }, user)).toMatchObject({ ok: false, code: 'MANDATORY' });
  });

  it('persists to an append-only log and rebuilds on restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rules-')), 'rules.jsonl');
    const a = await RuleStore.open(reg(), { log: new FileRuleLog(path) });
    await a.seed(wakeAll, 'bootstrap');
    const p = await a.propose({ op: 'upsert', rule: muteStaging, request: 'mute staging' }, user);
    if (!p.ok) throw new Error(p.reason);
    await a.backtest(p.value.changeId, history);
    await a.approve(p.value.changeId, p.value.fingerprint, user);
    await a.deploy(p.value.changeId, 'live');

    const b = await RuleStore.open(reg(), { log: new FileRuleLog(path) });
    await b.seed(wakeAll, 'bootstrap'); // idempotent
    expect(b.live().map((r) => `${r.id}@${r.version}`).sort()).toEqual(['mute-staging@1', 'wake-all@1']);
    expect(b.change(p.value.changeId)?.state).toBe('deployed');
    expect(b.history('wake-all')).toHaveLength(1);
  });
});
