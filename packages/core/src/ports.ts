import type { EventEnvelope } from '@agentevents/contract';

/** Domain code never reads wall-clock time directly (spec E2 §3.4). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class VirtualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Runtime state: dedup keys, window counters. Written by the engine only. */
export interface RuntimeState {
  /** Atomic check-and-set. Resolves true when the key was already present and unexpired. */
  seen(namespace: string, key: string, ttlMs: number, nowMs: number): Promise<boolean>;
  /** Record an occurrence at `atMs` and resolve the count within `(atMs - windowMs, atMs]`. */
  countInWindow(namespace: string, key: string, atMs: number, windowMs: number): Promise<number>;
}

export class MemoryRuntimeState implements RuntimeState {
  private readonly keys = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();

  async seen(namespace: string, key: string, ttlMs: number, nowMs: number): Promise<boolean> {
    const k = `${namespace}\u0000${key}`;
    const exp = this.keys.get(k);
    if (exp !== undefined && exp > nowMs) return true;
    this.keys.set(k, nowMs + ttlMs);
    return false;
  }

  async countInWindow(namespace: string, key: string, atMs: number, windowMs: number): Promise<number> {
    const k = `${namespace}\u0000${key}`;
    const list = (this.windows.get(k) ?? []).filter((t) => t > atMs - windowMs);
    list.push(atMs);
    this.windows.set(k, list);
    return list.filter((t) => t <= atMs).length;
  }
}

/** Append-only event log with opaque cursors (spec §1.1 cursor semantics). Ingest writes only. */
export interface EventLog {
  append(ev: EventEnvelope): Promise<number>;
  /** Events with offset > `after`, oldest first. */
  read(after: number, limit: number): Promise<{ offset: number; event: EventEnvelope }[]>;
  head(): Promise<number>;
  /** Oldest retained offset (for `truncated` / resync). */
  oldest(): Promise<number>;
}

/** Page through a whole log (backtests, redrives). */
export async function readAll(log: EventLog, pageSize = 1000): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  let after = 0;
  for (;;) {
    const page = await log.read(after, pageSize);
    if (!page.length) return out;
    out.push(...page.map((p) => p.event));
    after = page.at(-1)!.offset;
  }
}

export class MemoryEventLog implements EventLog {
  private readonly items: { offset: number; event: EventEnvelope }[] = [];
  private next = 1;
  constructor(private readonly maxRetained = 10_000) {}

  async append(ev: EventEnvelope): Promise<number> {
    const offset = this.next++;
    this.items.push({ offset, event: ev });
    if (this.items.length > this.maxRetained) this.items.shift();
    return offset;
  }
  async read(after: number, limit: number): Promise<{ offset: number; event: EventEnvelope }[]> {
    return this.items.filter((i) => i.offset > after).slice(0, limit);
  }
  async head(): Promise<number> {
    return this.next - 1;
  }
  async oldest(): Promise<number> {
    return this.items[0]?.offset ?? this.next;
  }
  all(): EventEnvelope[] {
    return this.items.map((i) => i.event);
  }
}

export const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | null | undefined, head: number): number {
  if (cursor === null || cursor === undefined) return head; // null cursor = "from now"
  const raw = Buffer.from(cursor, 'base64url').toString();
  const m = /^o:(\d+)$/u.exec(raw);
  if (!m?.[1]) throw new Error('invalid cursor');
  return Number(m[1]);
}

/** One entry in a subject thread (spec E3 §4.6). Events are stored masked, never raw. */
export interface ThreadEntry {
  at: number;
  kind: 'event' | 'agent' | 'user' | 'assistant';
  event?: EventEnvelope;
  /** `data.*` paths withheld by the screener when the event was first shown. */
  withheld?: string[];
  text?: string;
  by?: string;
}

/**
 * Durable per-thread context. Every turn appends to it, so the next turn (or a follow-up question)
 * starts from what the thread already knows.
 */
export interface ThreadMemory {
  append(threadId: string, entry: ThreadEntry): Promise<void>;
  /** The most recent `limit` entries, oldest first. */
  recent(threadId: string, limit: number): Promise<ThreadEntry[]>;
}

export class MemoryThreadMemory implements ThreadMemory {
  private readonly threads = new Map<string, ThreadEntry[]>();
  async append(threadId: string, entry: ThreadEntry): Promise<void> {
    const list = this.threads.get(threadId) ?? [];
    list.push(structuredClone(entry));
    this.threads.set(threadId, list);
  }
  async recent(threadId: string, limit: number): Promise<ThreadEntry[]> {
    return structuredClone((this.threads.get(threadId) ?? []).slice(-limit));
  }
}
