/**
 * Prompt-attack screener port (spec E3 §4.4). Untrusted fields that trip it, or any field when
 * the screener is unavailable, are withheld and the turn is marked tainted.
 */
export interface Screener {
  screen(text: string): Promise<'clean' | 'suspicious'> | 'clean' | 'suspicious';
}

const PATTERNS: readonly RegExp[] = [
  /\bignore (all |any )?(previous|prior|above) (instructions|messages)\b/iu,
  /\b(disregard|forget) (your|the) (instructions|rules|system prompt)\b/iu,
  /\byou are now\b/iu,
  /\bsystem prompt\b/iu,
  /<\/?\s*(system|event|instructions)\b/iu,
  /\b(call|run|invoke|execute) (the )?(tool|function)\b/iu,
  /\bapprove(d)? (this|the) (action|proposal|change)\b/iu,
];

/** Cheap heuristic default. Production hosts should plug in a model-based classifier. */
export const heuristicScreener: Screener = {
  screen: (text) => (PATTERNS.some((p) => p.test(text)) ? 'suspicious' : 'clean'),
};
