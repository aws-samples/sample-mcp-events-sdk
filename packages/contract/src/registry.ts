import { Ajv, type ValidateFunction } from 'ajv';
import { parseType, type EventEnvelope } from './envelope';

/** Spec E1 §2.3 — the `x-event` JSON Schema vocabulary keyword. */
export interface FieldAnnotation {
  filterable?: boolean;
  sensitivity?: 'none' | 'pii' | 'sensitive' | 'secret';
  mask?: 'full' | 'partial' | 'hash' | 'null';
  untrusted?: boolean;
  stability?: 'stable' | 'experimental';
  enumClosed?: boolean;
  arrivesLate?: boolean;
  pushdown?: boolean;
}

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  'x-event'?: FieldAnnotation;
  [k: string]: unknown;
};

/** Spec E3 §4.1 — server-suggested activation hints. The host decides. */
export interface ActivationHints {
  suggestedVerdict?: 'wake' | 'digest' | 'store' | 'drop';
  midTurn?: 'interrupt' | 'queue' | 'merge' | 'reject';
  coalesce?: { by: string[]; windowSeconds: number; max: number };
  replyTools?: string[];
  resultSchema?: JsonSchema;
  priority?: 'low' | 'normal' | 'high';
  deadlineSeconds?: number;
}

export interface EventTypeDef {
  /** Full type including major, e.g. `com.example.ops.alarm.v1`. */
  type: string;
  /** Minor/patch version of the schema within the major, e.g. `1.2.0`. */
  version: string;
  title: string;
  dataschema: string;
  schema: JsonSchema;
  hints?: ActivationHints;
  /** True when the type is a stateful situation (spec E2). */
  situation?: boolean;
  latencyP99Seconds?: number;
  availability?: { state: 'ready' | 'needs_setup' | 'unavailable'; reason?: string };
  /** Visible only to this tenant (spec E1 §2.2). */
  tenantid?: string;
}

export interface FieldInfo {
  path: string;
  type: string;
  annotation: FieldAnnotation;
  enum?: unknown[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: 'UNKNOWN_TYPE' | 'UNKNOWN_VERSION' | 'SCHEMA_INVALID'; reason: string };

/** Copy of a schema with `additionalProperties: false` on every object (the strict write schema). */
function strictCopy(s: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...s };
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strictCopy(v)]));
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (s.items) out.items = strictCopy(s.items);
  return out;
}

function flatten(schema: JsonSchema, prefix: string, out: FieldInfo[]): void {
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}.${name}`;
    const type = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type ?? 'unknown');
    out.push({ path, type, annotation: prop['x-event'] ?? {}, ...(prop.enum ? { enum: prop.enum } : {}) });
    if (prop.properties) flatten(prop, path, out);
  }
}

/**
 * Spec E1 §2.2 contract registry. Versions: a major lives in the type name; minors are additive.
 * Producers validate strictly; consumers read tolerantly; unknown majors are PARKED, not failed.
 */
export class SchemaRegistry {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly defs = new Map<string, EventTypeDef>();
  private readonly strict = new Map<string, ValidateFunction>();
  private readonly tolerant = new Map<string, ValidateFunction>();
  private readonly fieldIndex = new Map<string, Map<string, FieldInfo>>();

  constructor() {
    this.ajv.addKeyword({ keyword: 'x-event', schemaType: 'object' });
    this.ajv.addFormat('date-time', true);
  }

  register(def: EventTypeDef): void {
    parseType(def.type);
    const prev = this.defs.get(def.type);
    if (prev) assertAdditive(prev.schema, def.schema, def.type);
    this.defs.set(def.type, def);
    this.strict.set(def.type, this.ajv.compile(strictCopy(def.schema)));
    this.tolerant.set(def.type, this.ajv.compile(def.schema));
    const fields: FieldInfo[] = [];
    flatten(def.schema, 'data', fields);
    this.fieldIndex.set(def.type, new Map(fields.map((f) => [f.path, f])));
  }

  get(type: string): EventTypeDef | undefined {
    return this.defs.get(type);
  }

  list(tenantid?: string): EventTypeDef[] {
    return [...this.defs.values()].filter((d) => d.tenantid === undefined || d.tenantid === tenantid);
  }

  fields(type: string): Map<string, FieldInfo> {
    return this.fieldIndex.get(type) ?? new Map();
  }

  /** Producer-side validation (strict). */
  validateForWrite(ev: EventEnvelope): ValidationResult {
    return this.check(ev, this.strict);
  }

  /** Consumer-side validation (tolerant of additive fields). */
  validateForRead(ev: EventEnvelope): ValidationResult {
    return this.check(ev, this.tolerant);
  }

  /** Paths in `data` that the schema marks untrusted (feeds `untrustedfields`). */
  untrustedPaths(type: string): string[] {
    return [...this.fields(type).values()].filter((f) => f.annotation.untrusted).map((f) => f.path);
  }

  private check(ev: EventEnvelope, table: Map<string, ValidateFunction>): ValidationResult {
    const def = this.defs.get(ev.type);
    if (!def) {
      const { base, major } = parseType(ev.type);
      const known = [...this.defs.keys()].some((t) => parseType(t).base === base && parseType(t).major < major);
      return known
        ? { ok: false, code: 'UNKNOWN_VERSION', reason: `major ${major} of ${base} is not registered` }
        : { ok: false, code: 'UNKNOWN_TYPE', reason: `${ev.type} is not registered` };
    }
    const fn = table.get(ev.type)!;
    if (fn(ev.data)) return { ok: true };
    const reason = (fn.errors ?? []).map((e) => `data${e.instancePath} ${e.message ?? ''}`.trim()).join('; ');
    return { ok: false, code: 'SCHEMA_INVALID', reason };
  }
}

/** A minor version may only add optional fields (spec E1 §2.2). */
function assertAdditive(prev: JsonSchema, next: JsonSchema, type: string): void {
  const prevProps = prev.properties ?? {};
  const nextProps = next.properties ?? {};
  for (const [k, p] of Object.entries(prevProps)) {
    const n = nextProps[k];
    if (!n) throw new Error(`${type}: field "${k}" removed; breaking changes need a new major type`);
    if (JSON.stringify(p.type) !== JSON.stringify(n.type)) {
      throw new Error(`${type}: field "${k}" changed type; breaking changes need a new major type`);
    }
    if (p.properties || n.properties) assertAdditive(p, n, `${type}.${k}`);
  }
  const prevReq = new Set(prev.required ?? []);
  for (const r of next.required ?? []) {
    if (!prevReq.has(r)) throw new Error(`${type}: new required field "${r}"; minors may only add optional fields`);
  }
}
