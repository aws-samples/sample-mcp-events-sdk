import jsonata from 'jsonata';
import { FilterLanguage } from './vocab';
import { getPath, type EventEnvelope } from './envelope';
import type { SchemaRegistry } from './registry';

/**
 * Spec E1 §2.7: portable filter languages. `eb-pattern` is the bounded EventBridge-pattern
 * subset (dotted paths); `jsonata` is a boolean JSONata expression. No foreign code runs.
 */
export type PatternValue =
  | string
  | number
  | boolean
  | null
  | { prefix: string }
  | { suffix: string }
  | { 'equals-ignore-case': string }
  | { 'anything-but': string | number | (string | number)[] }
  | { numeric: (string | number)[] }
  | { exists: boolean };

export type FilterSpec =
  | { language: typeof FilterLanguage.EbPattern; expression: Record<string, PatternValue[]> }
  | { language: typeof FilterLanguage.Jsonata; expression: string };

export const FILTER_LANGUAGES = [FilterLanguage.EbPattern, FilterLanguage.Jsonata] as const;

const LIMITS = { paths: 10, values: 50, bytes: 2048 } as const;

/** Envelope attributes a filter may address (in addition to schema-declared, filterable data paths). */
const ENVELOPE_PATHS = new Set([
  'type', 'source', 'subject', 'partitionkey', 'provenance', 'actor.kind', 'actor.principal', 'origin',
  'situation.transition', 'situation.severity', 'situation.flags',
]);

export interface FilterIssue {
  path: string;
  reason: string;
}

export type FilterValidation =
  | { ok: true; features: string[] }
  | { ok: false; issues: FilterIssue[] };

/**
 * Type-check a filter against every event type it will be applied to. Unsupported constructs are
 * REJECTED, never ignored. Features are computed here, not declared by the caller.
 */
export function validateFilter(spec: FilterSpec, registry: SchemaRegistry, types: string[]): FilterValidation {
  const issues: FilterIssue[] = [];
  const features = new Set<string>([spec.language]);
  let paths: string[];

  if (spec.language === 'eb-pattern') {
    const expr = spec.expression;
    if (JSON.stringify(expr).length > LIMITS.bytes) issues.push({ path: '$', reason: `pattern exceeds ${LIMITS.bytes} bytes` });
    paths = Object.keys(expr);
    if (paths.length > LIMITS.paths) issues.push({ path: '$', reason: `more than ${LIMITS.paths} paths` });
    for (const [path, values] of Object.entries(expr)) {
      if (!Array.isArray(values) || values.length === 0) {
        issues.push({ path, reason: 'value list must be a non-empty array' });
        continue;
      }
      if (values.length > LIMITS.values) issues.push({ path, reason: `more than ${LIMITS.values} values` });
      for (const v of values) {
        const op = operatorOf(v);
        if (op === 'unknown') issues.push({ path, reason: `unsupported operator ${JSON.stringify(v)}` });
        else features.add(op);
        if (op === 'numeric') checkNumeric(path, v as { numeric: unknown[] }, issues);
      }
    }
  } else {
    try {
      paths = jsonataPaths(spec.expression);
    } catch (e) {
      return { ok: false, issues: [{ path: '$', reason: `jsonata syntax: ${(e as Error).message}` }] };
    }
  }

  for (const path of paths) {
    if (ENVELOPE_PATHS.has(path)) continue;
    if (!path.startsWith('data.')) {
      issues.push({ path, reason: 'not a filterable envelope attribute' });
      continue;
    }
    for (const type of types) {
      const f = registry.fields(type).get(path);
      if (!f) issues.push({ path, reason: `unknown field in ${type}` });
      else if (!f.annotation.filterable) issues.push({ path, reason: `field is not filterable in ${type}` });
      else if (spec.language === 'eb-pattern') checkTypes(path, spec.expression[path] ?? [], f, issues, type);
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, features: [...features].sort() };
}

export interface FilterEvaluation {
  match: boolean;
  /** For "why didn't this match" explanations. */
  firstFailingPath?: string;
}

export async function evaluateFilter(spec: FilterSpec, ev: EventEnvelope): Promise<FilterEvaluation> {
  if (spec.language === 'jsonata') {
    const out: unknown = await jsonata(spec.expression).evaluate(ev);
    return out === true ? { match: true } : { match: false, firstFailingPath: '$' };
  }
  for (const [path, values] of Object.entries(spec.expression)) {
    const actual = getPath(ev, path);
    const candidates = Array.isArray(actual) ? actual : [actual];
    const ok = values.some((v) => candidates.some((a) => matchValue(v, a, actual !== undefined)));
    if (!ok) return { match: false, firstFailingPath: path };
  }
  return { match: true };
}

function operatorOf(v: PatternValue): string {
  if (v === null || typeof v !== 'object') return 'equals';
  const keys = Object.keys(v);
  if (keys.length !== 1) return 'unknown';
  const k = keys[0]!;
  return ['prefix', 'suffix', 'equals-ignore-case', 'anything-but', 'numeric', 'exists'].includes(k) ? k : 'unknown';
}

function checkNumeric(path: string, v: { numeric: unknown[] }, issues: FilterIssue[]): void {
  const parts = v.numeric;
  if (parts.length !== 2 && parts.length !== 4) {
    issues.push({ path, reason: 'numeric takes [op, n] or [op, n, op, n]' });
    return;
  }
  for (let i = 0; i < parts.length; i += 2) {
    if (!['<', '<=', '=', '>=', '>'].includes(String(parts[i])) || typeof parts[i + 1] !== 'number') {
      issues.push({ path, reason: `bad numeric clause ${JSON.stringify(parts.slice(i, i + 2))}` });
    }
  }
}

function checkTypes(
  path: string,
  values: PatternValue[],
  f: { type: string; enum?: unknown[]; annotation: { enumClosed?: boolean } },
  issues: FilterIssue[],
  type: string,
): void {
  for (const v of values) {
    const op = operatorOf(v);
    if (op === 'numeric' && !/number|integer/u.test(f.type)) issues.push({ path, reason: `numeric on ${f.type} field in ${type}` });
    if (op === 'equals' && f.annotation.enumClosed && f.enum && !f.enum.includes(v)) {
      issues.push({ path, reason: `${JSON.stringify(v)} is not a value of the closed enum in ${type}` });
    }
  }
}

function matchValue(v: PatternValue, a: unknown, present: boolean): boolean {
  if (v === null || typeof v !== 'object') return a === v;
  if ('exists' in v) return v.exists === present;
  if (!present) return false;
  if ('prefix' in v) return typeof a === 'string' && a.startsWith(v.prefix);
  if ('suffix' in v) return typeof a === 'string' && a.endsWith(v.suffix);
  if ('equals-ignore-case' in v) return typeof a === 'string' && a.toLowerCase() === v['equals-ignore-case'].toLowerCase();
  if ('anything-but' in v) {
    const list = Array.isArray(v['anything-but']) ? v['anything-but'] : [v['anything-but']];
    return !list.includes(a as string | number);
  }
  if ('numeric' in v) {
    if (typeof a !== 'number') return false;
    for (let i = 0; i < v.numeric.length; i += 2) {
      const op = String(v.numeric[i]);
      const n = Number(v.numeric[i + 1]);
      const ok = op === '<' ? a < n : op === '<=' ? a <= n : op === '=' ? a === n : op === '>=' ? a >= n : a > n;
      if (!ok) return false;
    }
    return true;
  }
  return false;
}

type JsonataNode = { type?: string; value?: unknown; steps?: JsonataNode[]; [k: string]: unknown };

/** Collect dotted field paths referenced by a JSONata expression (for type-checking). */
function jsonataPaths(expr: string): string[] {
  const ast = jsonata(expr).ast() as JsonataNode;
  const out = new Set<string>();
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as JsonataNode;
    if (node.type === 'path' && Array.isArray(node.steps)) {
      const names: string[] = [];
      for (const s of node.steps) {
        if (s.type !== 'name') break;
        names.push(String(s.value));
      }
      if (names.length) out.add(names.join('.'));
      for (const s of node.steps) {
        // Predicates and stages inside a path are relative expressions; do not treat them as roots.
        if (s.type !== 'name') visit(s);
      }
      return;
    } else if (node.type === 'name') {
      out.add(String(node.value));
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast);
  return [...out];
}
