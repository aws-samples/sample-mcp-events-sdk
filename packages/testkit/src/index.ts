import { isDeepStrictEqual } from 'node:util';
import { deterministicId, runVectors, type EventEnvelope, type EventTypeDef, type JsonSchema, type Mapping, type MappedEvent, Provenance } from '@agentevents/contract';

/** Build a valid envelope with sensible defaults for tests and local emulation. */
export function makeEvent(def: EventTypeDef, data: Record<string, unknown>, over: Partial<EventEnvelope> = {}): EventEnvelope {
  const time = over.time ?? '2026-11-02T10:00:00.000Z';
  return {
    specversion: '1.0',
    id: deterministicId(over.source ?? 'test.local', JSON.stringify([def.type, data, time])),
    source: 'test.local',
    type: def.type,
    time,
    receivedat: time,
    dataschema: def.dataschema,
    provenance: Provenance.Live,
    untrustedfields: [],
    data,
    ...over,
  };
}

/**
 * Schema-driven fake data generator (spec §13 developer experience). Deterministic given a seed.
 */
export function fakeData(schema: JsonSchema, seed = 1): Record<string, unknown> {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  const gen = (sch: JsonSchema, name: string): unknown => {
    if (sch.enum) return sch.enum[Math.floor(rnd() * sch.enum.length)];
    const t = Array.isArray(sch.type) ? sch.type[0] : sch.type;
    switch (t) {
      case 'object':
        return Object.fromEntries(Object.entries(sch.properties ?? {}).map(([k, v]) => [k, gen(v, k)]));
      case 'array':
        return [gen(sch.items ?? {}, name)];
      case 'number':
      case 'integer':
        return Math.round(rnd() * 100);
      case 'boolean':
        return rnd() > 0.5;
      default:
        return `${name}-${Math.floor(rnd() * 1000)}`;
    }
  };
  return gen(schema, 'root') as Record<string, unknown>;
}

export interface PurityReport {
  deterministic: boolean;
  usedClock: boolean;
  usedRandom: boolean;
  usedFetch: boolean;
  vectorsPassed: boolean;
}

/**
 * Adapter / mapping conformance (spec E1 §2.5.1 and §8.3): transforms must be pure. Traps the clock,
 * randomness and network while running the vectors twice.
 */
export async function checkMappingPurity(m: Mapping): Promise<PurityReport> {
  const realNow = Date.now;
  const realRandom = Math.random;
  const realFetch = globalThis.fetch;
  const used = { clock: false, random: false, fetch: false };
  Date.now = () => {
    used.clock = true;
    return realNow();
  };
  Math.random = () => {
    used.random = true;
    return realRandom();
  };
  globalThis.fetch = (() => {
    used.fetch = true;
    return Promise.reject(new Error('network is not allowed in a mapping'));
  }) as typeof fetch;
  try {
    const a = await runVectors(m);
    const b = await runVectors(m);
    const outs = (r: { actual?: MappedEvent }[]) => r.map((x) => x.actual);
    return {
      deterministic: isDeepStrictEqual(outs(a), outs(b)),
      usedClock: used.clock,
      usedRandom: used.random,
      usedFetch: used.fetch,
      vectorsPassed: a.every((r) => r.ok),
    };
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    globalThis.fetch = realFetch;
  }
}
