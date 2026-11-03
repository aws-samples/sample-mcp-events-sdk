import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { EXT, sha256 } from '@agentevents/contract';

/** Spec E4 §5.2 reversibility tiers. */
export type Tier = 'safe' | 'reversible' | 'effort_to_reverse' | 'irreversible';
export const UNATTENDED_TIERS: ReadonlySet<Tier> = new Set(['safe', 'reversible']);
export const PROPOSABLE_TIERS: ReadonlySet<Tier> = new Set(['reversible', 'effort_to_reverse']);

export interface ActionMeta {
  tier: Tier;
  idempotencyKey?: string;
  /** The triggering event and flow, carried so resulting upstream events can set `causationid`. */
  causation?: { eventId?: string; correlationId?: string; actionId?: string };
}

export function tierOf(toolMeta: Record<string, unknown> | undefined): Tier | undefined {
  return (toolMeta?.[EXT.actions] as { tier?: Tier } | undefined)?.tier;
}

/** Spec E4 §5.4: sha256(tenant ‖ trigger ‖ tool ‖ target ‖ intent). */
export function idempotencyKey(parts: { tenant?: string; trigger: string; tool: string; target: string; intent?: string }): string {
  return `idem:${sha256([parts.tenant ?? '', parts.trigger, parts.tool, parts.target, parts.intent ?? ''].join('\u0000'))}`;
}

export type WriteState = 'started' | 'applied' | 'failed' | 'refused' | 'outcome_unknown';

interface WriteRecord {
  key: string;
  tool: string;
  target: string;
  state: WriteState;
  result?: CallToolResult;
  actionId: string;
}

export type BeginResult =
  | { kind: 'new'; actionId: string }
  | { kind: 'replay'; result: CallToolResult }
  | { kind: 'blocked'; reason: string };

/**
 * Spec E4 §5.4 write ledger: an effect runs at most once per key; `outcome_unknown` blocks further
 * writes to the same target until reconciled.
 */
export class WriteLedger {
  private readonly byKey = new Map<string, WriteRecord>();

  begin(key: string, tool: string, target: string): BeginResult {
    const existing = this.byKey.get(key);
    if (existing?.state === 'applied' && existing.result) return { kind: 'replay', result: existing.result };
    if (existing?.state === 'started') return { kind: 'blocked', reason: 'a write with this idempotency key is in progress' };
    const unknown = [...this.byKey.values()].find((r) => r.target === target && r.state === 'outcome_unknown');
    if (unknown) return { kind: 'blocked', reason: `target ${target} has a write with unknown outcome (${unknown.actionId}); reconcile first` };
    const actionId = `act_${randomUUID()}`;
    this.byKey.set(key, { key, tool, target, state: 'started', actionId });
    return { kind: 'new', actionId };
  }

  finish(key: string, state: Exclude<WriteState, 'started'>, result?: CallToolResult): void {
    const r = this.byKey.get(key);
    if (!r) throw new Error(`unknown write ${key}`);
    r.state = state;
    if (result) r.result = result;
  }

  reconcile(target: string, state: 'applied' | 'failed'): void {
    for (const r of this.byKey.values()) if (r.target === target && r.state === 'outcome_unknown') r.state = state;
  }

  records(): readonly WriteRecord[] {
    return [...this.byKey.values()];
  }
}

export class OutcomeUnknownError extends Error {}

export interface ActionContext {
  idempotencyKey: string;
  actionId: string;
  causation: ActionMeta['causation'];
}

export interface DefineActionOptions<Shape extends z.ZodRawShape> {
  title?: string;
  description: string;
  tier: Exclude<Tier, 'safe'>;
  inputSchema: Shape;
  /** Name of the argument holding the canonical target. Hosts check it came from a clean read. */
  targetArg: keyof Shape & string;
}

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * Register a side-effecting MCP tool with tier metadata, a required idempotency key, and the write
 * ledger. Throw `OutcomeUnknownError` from the handler when the effect may or may not have happened.
 */
export function defineAction<Shape extends z.ZodRawShape>(
  mcp: McpServer,
  ledger: WriteLedger,
  name: string,
  opts: DefineActionOptions<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ActionContext) => Promise<CallToolResult>,
): void {
  if (opts.tier === 'irreversible') {
    // Allowed to exist, but hosts will never run or propose it unattended (spec E4 §5.2).
  }
  mcp.registerTool(
    name,
    {
      ...(opts.title ? { title: opts.title } : {}),
      description: opts.description,
      inputSchema: opts.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: opts.tier !== 'reversible', idempotentHint: true },
      _meta: { [EXT.actions]: { tier: opts.tier, requiresIdempotencyKey: true, targetArg: opts.targetArg } },
    },
    (async (args: z.infer<z.ZodObject<Shape>>, extra: { _meta?: Record<string, unknown> }) => {
      const meta = extra._meta?.[EXT.actions] as ActionMeta | undefined;
      const key = meta?.idempotencyKey;
      if (!key) return errorResult(`${name} requires _meta["${EXT.actions}"].idempotencyKey`);
      const target = String((args as Record<string, unknown>)[opts.targetArg]);
      const begin = ledger.begin(key, name, target);
      if (begin.kind === 'replay') return begin.result;
      if (begin.kind === 'blocked') return errorResult(`refused: ${begin.reason}`);
      try {
        const result = await handler(args, { idempotencyKey: key, actionId: begin.actionId, causation: meta?.causation });
        const withId: CallToolResult = { ...result, _meta: { ...(result._meta ?? {}), [EXT.actions]: { actionId: begin.actionId, state: result.isError ? 'failed' : 'applied' } } };
        ledger.finish(key, result.isError ? 'failed' : 'applied', withId);
        return withId;
      } catch (e) {
        const unknown = e instanceof OutcomeUnknownError;
        ledger.finish(key, unknown ? 'outcome_unknown' : 'failed');
        return errorResult(unknown ? `outcome unknown: ${(e as Error).message}` : `failed: ${(e as Error).message}`);
      }
    }) as never,
  );
}

// ---- proposals (host side, spec E4 §5.3) -------------------------------------------------------

export interface Proposal {
  proposalId: string;
  fingerprint: string;
  tool: string;
  target: string;
  params: Record<string, unknown>;
  tier: Tier;
  approver: string;
  expiresAt: number;
  /** Situation that triggered it; approval is refused as stale once it resolved. */
  situationKey?: string;
  tainted: boolean;
  reason: string;
  /** The event and flow that triggered the proposal (for causation on execution). */
  trigger?: { eventId: string; correlationId?: string };
  state: 'pending' | 'approved' | 'declined' | 'expired' | 'stale';
  decisionKey?: string;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

export type DecideResult =
  | { ok: true; proposal: Proposal; replay: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'FINGERPRINT_MISMATCH' | 'NOT_APPROVER' | 'EXPIRED' | 'STALE' | 'ALREADY_DECIDED'; reason: string };

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();
  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  propose(p: { tenant?: string; tool: string; target: string; params: Record<string, unknown>; tier: Tier; approver: string; situationKey?: string; tainted: boolean; reason: string; trigger?: { eventId: string; correlationId?: string } }): Proposal {
    if (!PROPOSABLE_TIERS.has(p.tier)) throw new Error(`tier ${p.tier} is not proposable`);
    const fingerprint = `sha256:${sha256([p.tenant ?? '', p.tool, p.target, canonical(p.params)].join('\u0000'))}`;
    const proposal: Proposal = {
      proposalId: `prop_${randomUUID()}`,
      fingerprint,
      tool: p.tool,
      target: p.target,
      params: p.params,
      tier: p.tier,
      approver: p.approver,
      expiresAt: this.now() + this.ttlMs,
      tainted: p.tainted,
      reason: p.reason,
      state: 'pending',
      ...(p.situationKey ? { situationKey: p.situationKey } : {}),
      ...(p.trigger ? { trigger: p.trigger } : {}),
    };
    this.items.set(proposal.proposalId, proposal);
    return proposal;
  }

  decide(d: { proposalId: string; fingerprint: string; decision: 'approve' | 'decline'; decider: string; decisionKey: string; isResolved?: (situationKey: string) => boolean }): DecideResult {
    const p = this.items.get(d.proposalId);
    if (!p) return { ok: false, code: 'NOT_FOUND', reason: 'no such proposal' };
    if (p.decisionKey === d.decisionKey) return { ok: true, proposal: p, replay: true };
    if (p.state !== 'pending') return { ok: false, code: 'ALREADY_DECIDED', reason: `proposal is ${p.state}` };
    if (p.fingerprint !== d.fingerprint) return { ok: false, code: 'FINGERPRINT_MISMATCH', reason: 'the proposal changed; review it again' };
    if (p.approver !== d.decider) return { ok: false, code: 'NOT_APPROVER', reason: `only ${p.approver} may decide` };
    if (this.now() > p.expiresAt) {
      p.state = 'expired';
      return { ok: false, code: 'EXPIRED', reason: 'proposal expired' };
    }
    if (d.decision === 'approve' && p.situationKey && d.isResolved?.(p.situationKey)) {
      p.state = 'stale';
      return { ok: false, code: 'STALE', reason: 'the triggering situation resolved before approval' };
    }
    p.state = d.decision === 'approve' ? 'approved' : 'declined';
    p.decisionKey = d.decisionKey;
    return { ok: true, proposal: p, replay: false };
  }

  pending(): Proposal[] {
    return [...this.items.values()].filter((p) => p.state === 'pending');
  }

  get(id: string): Proposal | undefined {
    return this.items.get(id);
  }
}
