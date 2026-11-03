/**
 * The shared vocabularies of the Event-Driven MCP pattern, as enum objects.
 *
 * Use the members in code (`Verdict.Wake`, `Autonomy.Propose`) instead of string literals. Each enum
 * also exports a type of the same name, the union of its values, so data parsed from the wire or from
 * stored rules (plain strings) still type-checks. The values are the wire format and never change.
 */

/** Builds the type of an enum object: the union of its values. */
type ValueOf<T> = T[keyof T];

// ─── Activation (spec E3 §4.3) ─────────────────────────────────────────────────────────────

/** Whether the model runs. */
export const Verdict = {
  Drop: 'drop',
  Store: 'store',
  Digest: 'digest',
  Wake: 'wake',
  Decide: 'decide',
  Escalate: 'escalate',
} as const;
export type Verdict = ValueOf<typeof Verdict>;

/** What the model may do once it runs. Ordered from least to most authority. */
export const Autonomy = {
  Notify: 'notify',
  Investigate: 'investigate',
  Propose: 'propose',
  Act: 'act',
} as const;
export type Autonomy = ValueOf<typeof Autonomy>;

/** What a host does with an event that arrives during a running turn (spec E3 §4.5). */
export const MidTurn = {
  Interrupt: 'interrupt',
  Queue: 'queue',
  Merge: 'merge',
  Reject: 'reject',
} as const;
export type MidTurn = ValueOf<typeof MidTurn>;

export const Priority = { Low: 'low', Normal: 'normal', High: 'high' } as const;
export type Priority = ValueOf<typeof Priority>;

// ─── Event contract (spec E1 §2.1, §2.3) ───────────────────────────────────────────────────

/** Where an event came from. Only `live` and `redrive` may ever wake a model or take a decision. */
export const Provenance = {
  Live: 'live',
  Redrive: 'redrive',
  Replay: 'replay',
  Recover: 'recover',
  Baseline: 'baseline',
} as const;
export type Provenance = ValueOf<typeof Provenance>;

export const ActorKind = { User: 'user', Service: 'service', Platform: 'platform', Unknown: 'unknown' } as const;
export type ActorKind = ValueOf<typeof ActorKind>;

export const Sensitivity = { None: 'none', Pii: 'pii', Sensitive: 'sensitive', Secret: 'secret' } as const;
export type Sensitivity = ValueOf<typeof Sensitivity>;

export const MaskMode = { Full: 'full', Partial: 'partial', Hash: 'hash', Null: 'null' } as const;
export type MaskMode = ValueOf<typeof MaskMode>;

export const Stability = { Stable: 'stable', Experimental: 'experimental' } as const;
export type Stability = ValueOf<typeof Stability>;

// ─── Situations (spec E2) ──────────────────────────────────────────────────────────────────

export const Transition = { Open: 'open', Update: 'update', Resolve: 'resolve' } as const;
export type Transition = ValueOf<typeof Transition>;

export const Severity = { Info: 'info', Low: 'low', Medium: 'medium', High: 'high', Critical: 'critical' } as const;
export type Severity = ValueOf<typeof Severity>;

export const SituationFlag = {
  Flapping: 'flapping',
  Suppressed: 'suppressed',
  Storm: 'storm',
  Late: 'late',
  Stale: 'stale',
  Seeded: 'seeded',
} as const;
export type SituationFlag = ValueOf<typeof SituationFlag>;

// ─── Delivery (SEP-3415) ───────────────────────────────────────────────────────────────────

export const DeliveryMode = { Poll: 'poll', Stream: 'stream', Webhook: 'webhook' } as const;
export type DeliveryMode = ValueOf<typeof DeliveryMode>;

export const DeliveryStatus = { Active: 'active', Failing: 'failing', Failed: 'failed', Expired: 'expired' } as const;
export type DeliveryStatus = ValueOf<typeof DeliveryStatus>;

// ─── Filters (spec E1 §2.7) ────────────────────────────────────────────────────────────────

export const FilterLanguage = { EbPattern: 'eb-pattern', Jsonata: 'jsonata' } as const;
export type FilterLanguage = ValueOf<typeof FilterLanguage>;
