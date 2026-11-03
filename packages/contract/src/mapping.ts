import { isDeepStrictEqual } from 'node:util';
import jsonata from 'jsonata';
import { deterministicId, sha256, type Actor, type EventEnvelope } from './envelope';
import { FilterLanguage, type Provenance } from './vocab';
import type { SchemaRegistry } from './registry';

/** What a transform produces. Envelope identity, tenant and trust fields are NOT the transform's to set. */
export interface MappedEvent {
  data: Record<string, unknown>;
  time: string;
  subject?: string;
  partitionkey?: string;
  correlationid?: string;
  causationid?: string;
  actor?: Actor;
  origin?: string;
  dedupkey?: string;
  traceparent?: string;
}

export type Transform =
  | { language: typeof FilterLanguage.Jsonata; expression: string }
  /** Escape hatch (spec E1 §2.5.1). MUST be pure: no I/O, clock or randomness. */
  | { language: 'code'; fn: (raw: unknown) => MappedEvent };

export interface Mapping {
  id: string;
  version: string;
  source: { system: string; schema: string; version: string };
  target: { type: string };
  /** JSONata path to the upstream id; drives layer-1 dedup and the deterministic `id`. */
  upstreamId: string;
  /** JSONata expression producing the CloudEvents `source` URI. */
  sourceUri: string;
  transform: Transform;
  dedupKey?: { fields: string[]; windowSeconds: number };
  vectors: { name: string; input: unknown; expect: MappedEvent }[];
}

/** Trusted context comes from the delivery binding (spec A7), never from the payload. */
export interface IngestContext {
  tenantid?: string;
  receivedat: string;
  provenance: Provenance;
  /** Principals the platform itself acts as. Matching events get `actor.kind = platform`. */
  platformPrincipals?: readonly string[];
}

export class MappingError extends Error {
  constructor(
    readonly code: 'NO_UPSTREAM_ID' | 'TRANSFORM_FAILED' | 'UNKNOWN_TARGET',
    message: string,
  ) {
    super(message);
  }
}

async function evalString(expr: string, raw: unknown): Promise<string | undefined> {
  const v: unknown = await jsonata(expr).evaluate(raw);
  return v === undefined || v === null ? undefined : String(v);
}

export async function applyTransform(t: Transform, raw: unknown): Promise<MappedEvent> {
  if (t.language === 'code') return t.fn(raw);
  const out = (await jsonata(t.expression).evaluate(raw)) as MappedEvent | undefined;
  if (!out || typeof out !== 'object' || !out.data || !out.time) {
    throw new MappingError('TRANSFORM_FAILED', 'transform must return { data, time, ... }');
  }
  return JSON.parse(JSON.stringify(out)) as MappedEvent;
}

export async function upstreamIdOf(m: Mapping, raw: unknown): Promise<string> {
  const id = await evalString(m.upstreamId, raw);
  if (!id) throw new MappingError('NO_UPSTREAM_ID', `${m.id}: upstream id not found at ${m.upstreamId}`);
  return id;
}

/** Run a mapping and build a full envelope. Identity is deterministic; tenant comes from ctx only. */
export async function runMapping(
  m: Mapping,
  raw: unknown,
  ctx: IngestContext,
  registry: SchemaRegistry,
): Promise<EventEnvelope> {
  const def = registry.get(m.target.type);
  if (!def) throw new MappingError('UNKNOWN_TARGET', `${m.id}: target ${m.target.type} not registered`);
  const upstream = await upstreamIdOf(m, raw);
  const source = await evalString(m.sourceUri, raw);
  if (!source) throw new MappingError('TRANSFORM_FAILED', `${m.id}: source not found`);
  let mapped: MappedEvent;
  try {
    mapped = await applyTransform(m.transform, raw);
  } catch (e) {
    if (e instanceof MappingError) throw e;
    throw new MappingError('TRANSFORM_FAILED', `${m.id}: ${(e as Error).message}`);
  }

  let actor = mapped.actor;
  if (actor?.principal && ctx.platformPrincipals?.includes(actor.principal)) actor = { ...actor, kind: 'platform' };

  let dedupkey = mapped.dedupkey;
  if (!dedupkey && m.dedupKey) {
    const parts = await Promise.all(m.dedupKey.fields.map((f) => evalString(f, { data: mapped.data })));
    dedupkey = `sha256:${sha256(parts.map((p) => p ?? '').join('\u0000'))}`;
  }

  return {
    specversion: '1.0',
    id: deterministicId(source, upstream),
    source,
    type: m.target.type,
    time: mapped.time,
    receivedat: ctx.receivedat,
    dataschema: def.dataschema,
    provenance: ctx.provenance,
    untrustedfields: registry.untrustedPaths(m.target.type),
    data: mapped.data,
    ...(mapped.subject ? { subject: mapped.subject } : {}),
    ...(mapped.partitionkey ? { partitionkey: mapped.partitionkey } : {}),
    ...(mapped.correlationid ? { correlationid: mapped.correlationid } : {}),
    ...(mapped.causationid ? { causationid: mapped.causationid } : {}),
    ...(mapped.traceparent ? { traceparent: mapped.traceparent } : {}),
    ...(mapped.origin ? { origin: mapped.origin } : {}),
    ...(actor ? { actor } : {}),
    ...(dedupkey ? { dedupkey } : {}),
    ...(ctx.tenantid ? { tenantid: ctx.tenantid } : {}),
  };
}

export interface VectorResult {
  name: string;
  ok: boolean;
  actual?: MappedEvent;
  error?: string;
}

/** Spec E1 §2.5: test vectors run in CI and in the conformance suite. */
export async function runVectors(m: Mapping): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  for (const v of m.vectors) {
    try {
      const actual = await applyTransform(m.transform, v.input);
      results.push({ name: v.name, ok: isDeepStrictEqual(actual, v.expect), actual });
    } catch (e) {
      results.push({ name: v.name, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
