/**
 * Spec §7 terminal trace verdict taxonomy. Every event ends with exactly one code, and every code
 * has a sentence and a fix, so "why didn't the agent react?" always has an answer.
 */
export const TRACE = {
  REFUSED_SCHEMA: { sentence: 'The event did not match its published schema.', fix: 'Fix the producer or its mapping; see the validation reason.' },
  REFUSED_UNKNOWN_TYPE: { sentence: 'The event type is not registered.', fix: 'Register the type, or add a mapping for this source.' },
  REFUSED_MAPPING: { sentence: 'No mapping could transform the upstream payload.', fix: 'Check the mapping test vectors against this payload.' },
  PARKED_UNKNOWN_VERSION: { sentence: 'The event uses a schema major this consumer does not know yet; it was parked, not dropped.', fix: 'Deploy a reader for the new major, then redrive parked events.' },
  DEDUPED_L1: { sentence: 'The upstream delivered the same event again.', fix: 'Nothing to do; upstream retries are expected.' },
  DEDUPED_L2: { sentence: 'The same event (source + id) was already received.', fix: 'Nothing to do; at-least-once delivery is expected.' },
  DEDUPED_L3: { sentence: 'A semantically identical event was seen within its dedup window.', fix: 'Shorten the dedup window if these should be separate.' },
  FILTER_MISS: { sentence: 'The subscription filter did not match.', fix: 'Check the first failing path and widen the filter.' },
  NOT_LIVE: { sentence: 'Replayed, recovered or baseline events never wake the agent.', fix: 'Nothing to do; this protects against acting on history.' },
  EXPIRED: { sentence: 'The event expired or arrived too late to act on.', fix: 'Check source lag; raise the staleness budget if appropriate.' },
  LOOP: { sentence: "The event was caused by the agent's or platform's own action.", fix: 'Nothing to do; this prevents feedback loops.' },
  QUIET: { sentence: 'The situation is suppressed, flapping, or part of a storm roll-up.', fix: 'See the storm or flapping situation instead.' },
  RULE_DROP: { sentence: 'A rule dropped the event.', fix: 'Review the named rule version with rules_explain.' },
  STORED: { sentence: 'The event was stored without waking the agent.', fix: 'Add or change a rule if it should wake the agent.' },
  DIGESTED: { sentence: 'The event was batched into the next digest.', fix: 'Mark the type urgent or add a wake rule.' },
  WOKEN: { sentence: 'The event woke the agent.', fix: 'Nothing to do.' },
  COALESCED: { sentence: 'The event was merged into another turn for the same subject.', fix: 'Nothing to do; see the turn that absorbed it.' },
  DECIDED: { sentence: 'A rule decided the outcome in code without the agent.', fix: 'Review the named rule version.' },
  ESCALATED: { sentence: 'The event was escalated to a review queue.', fix: 'Nothing to do.' },
  REJECTED_MID_TURN: { sentence: 'A turn was already running and the type rejects mid-turn delivery.', fix: 'The source will retry; or change the mid-turn policy.' },
  SUSPENDED: { sentence: 'The rule owner is no longer authorized, so activation is suspended.', fix: 'Restore the owner\'s access or reassign the rule.' },
  BUDGET: { sentence: 'The tenant spend budget or a rate limit was reached.', fix: 'Raise the budget/limit or wait for it to reset.' },
} as const;

export type TraceCode = keyof typeof TRACE;

export function explainCode(code: TraceCode): string {
  const t = TRACE[code];
  return `${code}: ${t.sentence} Fix: ${t.fix}`;
}
