import { sha256, type EventEnvelope } from './envelope';
import type { JsonSchema, SchemaRegistry } from './registry';

export const REDACTOR_VERSION = 'redact/1';

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bwhsec_[A-Za-z0-9+/=]{16,}\b/u,
];

export const looksLikeCredential = (s: string): boolean => CREDENTIAL_SHAPES.some((r) => r.test(s));

export interface RedactionResult {
  event: EventEnvelope;
  redactorVersion: string;
  /** Paths removed: not in the allowlist, `secret`, or credential-shaped. */
  removed: string[];
}

/**
 * Spec E1 §2.4: runs BEFORE persistence. Allowlist per type: only schema-declared fields survive.
 * Unknown type → envelope only (fail closed). `secret` fields and credential-shaped values are removed.
 */
export function redactForPersist(ev: EventEnvelope, registry: SchemaRegistry): RedactionResult {
  const def = registry.get(ev.type);
  const removed: string[] = [];
  if (!def) {
    removed.push(...Object.keys(ev.data).map((k) => `data.${k}`));
    return { event: { ...ev, data: {} }, redactorVersion: REDACTOR_VERSION, removed };
  }
  const data = walkPersist(ev.data, def.schema, 'data', removed) as Record<string, unknown>;
  return { event: { ...ev, data }, redactorVersion: REDACTOR_VERSION, removed };
}

function walkPersist(value: unknown, schema: JsonSchema, path: string, removed: string[]): unknown {
  if (schema['x-event']?.sensitivity === 'secret') {
    removed.push(path);
    return undefined;
  }
  if (typeof value === 'string') {
    if (looksLikeCredential(value)) {
      removed.push(path);
      return '[redacted:credential]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => walkPersist(v, schema.items ?? {}, `${path}.${i}`, removed));
  }
  if (value !== null && typeof value === 'object') {
    const props = schema.properties;
    if (!props) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = props[k];
      if (!child) {
        removed.push(`${path}.${k}`);
        continue;
      }
      const r = walkPersist(v, child, `${path}.${k}`, removed);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

/** Spec E3 §4.4: mask `pii` / `sensitive` fields before anything is rendered to a model. */
export function maskForRender(ev: EventEnvelope, registry: SchemaRegistry): EventEnvelope {
  const def = registry.get(ev.type);
  if (!def) return { ...ev, data: {} };
  return { ...ev, data: walkMask(ev.data, def.schema) as Record<string, unknown> };
}

function walkMask(value: unknown, schema: JsonSchema): unknown {
  const ann = schema['x-event'];
  if (ann?.sensitivity === 'secret') return undefined;
  if ((ann?.sensitivity === 'pii' || ann?.sensitivity === 'sensitive') && value !== undefined) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    switch (ann.mask ?? 'full') {
      case 'partial':
        return `***${s.slice(-4)}`;
      case 'hash':
        return `sha256:${sha256(s).slice(0, 12)}`;
      case 'null':
        return null;
      default:
        return `[${ann.sensitivity}:masked]`;
    }
  }
  if (Array.isArray(value)) return value.map((v) => walkMask(v, schema.items ?? {}));
  if (value !== null && typeof value === 'object' && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = schema.properties[k];
      if (!child) continue;
      const r = walkMask(v, child);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}
