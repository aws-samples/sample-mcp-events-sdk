/**
 * Reproducible gate benchmark: how much of an event stream reaches the model, and at what cost per event.
 * 20,000 events through the full host pipeline (safety gates + 300 eb-pattern rules), memory state.
 * About 10% of events match a wake rule; everything else is stored by code with no model call.
 *   npx tsx scripts/bench-gates.ts
 */
import { SchemaRegistry, type EventTypeDef } from '@agentevents/contract';
import { GatePipeline, MemoryRuntimeState, VirtualClock, emergencyStopGate, expiryGate, loopGate, provenanceGate, quietGate, ruleGate, semanticDedupGate, type Rule } from '@agentevents/core';
import { makeEvent } from '@agentevents/testkit';

const def: EventTypeDef = {
  type: 'com.example.bench.alarm.v1', version: '1.0.0', title: 'bench', dataschema: 'https://s.example.com/b.json',
  schema: { type: 'object', properties: { service: { type: 'string', 'x-event': { filterable: true } }, env: { type: 'string', 'x-event': { filterable: true } }, value: { type: 'number', 'x-event': { filterable: true } } } },
};
const reg = new SchemaRegistry();
reg.register(def);

const RULES = 300;
const EVENTS = 20_000;
const rules: Rule[] = Array.from({ length: RULES }, (_, i) => ({
  id: `r${i}`, version: 1, priority: i, description: `rule ${i}`, types: [def.type],
  // Rule 0 wakes on prod with value >= 90 (~10% of events); the rest match services that never occur.
  filter: { language: 'eb-pattern', expression: i === 0 ? { 'data.env': ['prod'], 'data.value': [{ numeric: ['>=', 90] }] } : { 'data.service': [`never-${i}`] } },
  verdict: i === 0 ? 'wake' : 'store',
}));
const state = new MemoryRuntimeState();
const clock = new VirtualClock(Date.parse('2026-11-02T10:00:00Z'));
const pipeline = new GatePipeline(
  [provenanceGate(), expiryGate({ stalenessMs: 3_600_000 }), loopGate({ causedByUs: () => false }), quietGate(), semanticDedupGate({ windowMs: 600_000 }), emergencyStopGate({ state: () => 'running' })],
  () => [ruleGate(() => rules)],
  { defaultVerdict: 'store', defaultAutonomy: 'investigate' },
);

const events = Array.from({ length: EVENTS }, (_, i) => makeEvent(def, { service: `svc-${i % 50}`, env: 'prod', value: i % 100 }, { source: `b${i}`, time: '2026-11-02T10:00:00.000Z', receivedat: '2026-11-02T10:00:00.000Z' }));
const times: number[] = [];
let wakes = 0;
for (const event of events) {
  const t0 = performance.now();
  const d = await pipeline.decide({ event, def, clock, state });
  times.push(performance.now() - t0);
  if (d.verdict === 'wake') wakes++;
}
times.sort((a, b) => a - b);
const q = (p: number) => times[Math.floor(p * (times.length - 1))]!.toFixed(3);
console.log(JSON.stringify({ events: EVENTS, rules: RULES, p50ms: q(0.5), p99ms: q(0.99), wakes, noModelShare: `${(((EVENTS - wakes) / EVENTS) * 100).toFixed(1)}%`, node: process.version }));
