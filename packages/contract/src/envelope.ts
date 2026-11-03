import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ActorKind, Provenance, Severity, SituationFlag, Transition } from './vocab';

/** Spec E1 §2.1. Only `live` and `redrive` may ever wake a model or take a decision. */
export const Actor = z.object({ kind: z.enum(ActorKind), principal: z.string().optional() });
export type Actor = z.infer<typeof Actor>;

export const SituationMeta = z.object({
  situationkey: z.string(),
  transition: z.enum(Transition),
  revision: z.number().int().positive(),
  previousid: z.string().optional(),
  severity: z.enum(Severity),
  occurrences: z.object({ count: z.number().int(), firstSeenAt: z.string(), lastSeenAt: z.string() }),
  evidence: z.object({ first: z.array(z.string()), last: z.array(z.string()) }),
  flags: z.array(z.enum(SituationFlag)),
  group: z.object({ key: z.string(), dimensions: z.record(z.string(), z.string()) }).optional(),
});
export type SituationMeta = z.infer<typeof SituationMeta>;

/** CloudEvents 1.0 envelope plus the agent attributes of spec E1 §2.1. */
export const EventEnvelope = z.object({
  specversion: z.literal('1.0'),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().regex(/^[a-z0-9]+(\.[a-z0-9_]+)+\.v\d+$/u, 'reverse-DNS type with .vN major suffix'),
  time: z.string().datetime({ offset: true }),
  receivedat: z.string().datetime({ offset: true }),
  dataschema: z.string().url(),
  subject: z.string().optional(),
  partitionkey: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u).optional(),
  correlationid: z.string().optional(),
  causationid: z.string().optional(),
  actor: Actor.optional(),
  origin: z.string().optional(),
  tenantid: z.string().optional(),
  provenance: z.enum(Provenance),
  expiresat: z.string().datetime({ offset: true }).optional(),
  dedupkey: z.string().optional(),
  untrustedfields: z.array(z.string()),
  rawref: z.object({ uri: z.string(), sha256: z.string() }).optional(),
  situation: SituationMeta.optional(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Spec E1 §2.1: `id` is derived from source + upstream id, never random. */
export function deterministicId(source: string, upstreamId: string): string {
  return `sha256:${sha256(`${source}\u0000${upstreamId}`)}`;
}

/** `com.example.ops.alarm.v1` → `{ base: 'com.example.ops.alarm', major: 1 }` */
export function parseType(type: string): { base: string; major: number } {
  const m = /^(.*)\.v(\d+)$/u.exec(type);
  if (!m?.[1] || !m[2]) throw new Error(`event type without major suffix: ${type}`);
  return { base: m[1], major: Number(m[2]) };
}

/** Read a JSON-pointer-ish dotted path (`data.alarm.name`) from an envelope. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
