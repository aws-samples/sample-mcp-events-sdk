import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import dynalite from 'dynalite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaRegistry, type EventTypeDef, Autonomy, Verdict, FilterLanguage } from '@agentevents/contract';
import { MemoryDecisionStore, MemoryEventLog, MemoryRuntimeState, MemoryThreadMemory, readAll, type Decision, type DecisionStore, type EventLog, type RuntimeState, type ThreadMemory } from '@agentevents/core';
import { MemoryRuleLog, RuleStore, type RuleLog, ChangeOp, DeployMode, RequestOrigin } from '@agentevents/rules';
import { DynamoDecisionStore, DynamoEventLog, DynamoRuleLog, DynamoRuntimeState, DynamoThreadMemory, documentClient, ensureTable } from '@agentevents/store-dynamodb';
import { makeEvent } from '@agentevents/testkit';

/**
 * Port conformance: the same assertions run against the memory adapters and the DynamoDB adapters
 * (dynalite, an in-process DynamoDB emulator bound to 127.0.0.1; no AWS account is touched).
 */
let server: Server;
let client: DynamoDBClient;
const TABLE = 'agentevents-test';

beforeAll(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${port}`, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  await ensureTable(client, TABLE);
  await ensureTable(client, TABLE); // idempotent
});
afterAll(async () => {
  client.destroy();
  await new Promise((r) => server.close(r));
});

const def: EventTypeDef = { type: 'com.example.t.alarm.v1', version: '1.0.0', title: 't', dataschema: 'https://s.example.com/t.json', schema: { type: 'object', properties: { n: { type: 'number', 'x-event': { filterable: true } } } } };
let uniq = 0;
const name = (): string => `t${Date.now()}-${++uniq}`;
const doc = () => documentClient(client);

const impls: { label: string; log: () => EventLog; state: () => RuntimeState; decisions: () => DecisionStore; rules: () => RuleLog; threads: () => ThreadMemory }[] = [
  { label: 'memory', log: () => new MemoryEventLog(), state: () => new MemoryRuntimeState(), decisions: () => new MemoryDecisionStore(), rules: () => new MemoryRuleLog(), threads: () => new MemoryThreadMemory() },
  {
    label: 'dynamodb',
    log: () => new DynamoEventLog({ doc: doc(), table: TABLE, name: name() }),
    state: () => new DynamoRuntimeState({ doc: doc(), table: TABLE }),
    decisions: () => new DynamoDecisionStore({ doc: doc(), table: TABLE }),
    rules: () => new DynamoRuleLog({ doc: doc(), table: TABLE, name: name() }),
    threads: () => new DynamoThreadMemory({ doc: doc(), table: TABLE }),
  },
];

describe.each(impls)('$label stores', (impl) => {
  it('event log: offsets, paging, head/oldest', async () => {
    const log = impl.log();
    expect(await log.head()).toBe(0);
    for (let i = 1; i <= 5; i++) expect(await log.append(makeEvent(def, { n: i }))).toBe(i);
    expect(await log.head()).toBe(5);
    expect(await log.oldest()).toBe(1);
    const page = await log.read(2, 2);
    expect(page.map((p) => [p.offset, p.event.data['n']])).toEqual([[3, 3], [4, 4]]);
    expect((await readAll(log, 2)).map((e) => e.data['n'])).toEqual([1, 2, 3, 4, 5]);
    expect(await log.read(5, 10)).toEqual([]);
  });

  it('runtime state: atomic seen with TTL; window counts', async () => {
    const st = impl.state();
    const ns = name();
    expect(await st.seen(ns, 'k', 1000, 10_000)).toBe(false);
    expect(await st.seen(ns, 'k', 1000, 10_500)).toBe(true);
    expect(await st.seen(ns, 'k', 1000, 11_001)).toBe(false); // expired, re-armed
    expect(await st.seen(ns, 'other', 1000, 10_500)).toBe(false);
    // concurrent check-and-set: exactly one caller wins
    const results = await Promise.all(Array.from({ length: 8 }, () => st.seen(ns, 'race', 60_000, 20_000)));
    expect(results.filter((r) => !r)).toHaveLength(1);

    const counts = [];
    for (const at of [1_000, 2_000, 3_000, 20_000]) counts.push(await st.countInWindow(ns, 'w', at, 10_000));
    expect(counts).toEqual([1, 2, 3, 1]);
  });

  it('decision records: by event and most recent first', async () => {
    const store = impl.decisions();
    const id = name();
    const base: Decision = { eventId: id, type: def.type, subject: 's', verdict: Verdict.Store, autonomy: Autonomy.Notify, downgrades: [], code: 'STORED', reason: 'r', gates: [], decidedAt: Date.now() };
    await store.put(base);
    await store.put({ ...base, verdict: Verdict.Wake, code: 'WOKEN', decidedAt: base.decidedAt + 1 });
    expect((await store.forEvent(id)).map((d) => d.verdict).sort()).toEqual([Verdict.Store, Verdict.Wake]);
    const recent = await store.recent(2);
    expect(recent[0]?.verdict).toBe(Verdict.Wake);
  });

  it('thread memory: appends and returns the most recent entries oldest first', async () => {
    const m = impl.threads();
    const id = name();
    for (let i = 1; i <= 5; i++) await m.append(id, { at: 1_000 + i, kind: i % 2 ? 'agent' : 'user', text: `t${i}` });
    expect((await m.recent(id, 3)).map((e) => e.text)).toEqual(['t3', 't4', 't5']);
    expect(await m.recent(`${id}-other`, 3)).toEqual([]);
  });

  it('rule log: a RuleStore rebuilds identically from it', async () => {
    const reg = new SchemaRegistry();
    reg.register(def);
    const log = impl.rules();
    const a = await RuleStore.open(reg, { log });
    await a.seed({ id: 'r1', version: 1, description: 'wake', types: [def.type], verdict: Verdict.Wake }, 'bootstrap');
    const p = await a.propose({ op: ChangeOp.Upsert, rule: { id: 'r2', description: 'digest big', types: [def.type], filter: { language: FilterLanguage.EbPattern, expression: { 'data.n': [{ numeric: ['>', 5] }] } }, verdict: Verdict.Digest }, request: 'digest big ones' }, { id: 'u', roles: ['rule-owner'], origin: RequestOrigin.User });
    if (!p.ok) throw new Error(p.reason);
    await a.backtest(p.value.changeId, []);
    await a.approve(p.value.changeId, p.value.fingerprint, { id: 'u', roles: ['rule-owner'], origin: RequestOrigin.User });
    await a.deploy(p.value.changeId, DeployMode.Live);
    const b = await RuleStore.open(reg, { log });
    expect(b.live().map((r) => `${r.id}@${r.version}`).sort()).toEqual(['r1@1', 'r2@1']);
    expect(b.change(p.value.changeId)?.state).toBe('deployed');
  });
});
