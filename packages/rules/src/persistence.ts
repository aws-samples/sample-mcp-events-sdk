import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuleChange, RuleVersion } from './store';

/**
 * Persistence port for the rule store (spec §8.1: memory, DynamoDB, Postgres behind one port).
 * Append-only: every mutation appends an entity snapshot; state is rebuilt by replaying the log,
 * so rule history is durable, auditable and replayable. Last record per entity wins.
 */
export type RuleLogRecord =
  | { kind: 'versions'; at: string; ruleId: string; versions: RuleVersion[] }
  | { kind: 'change'; at: string; change: RuleChange };

export interface RuleLog {
  append(rec: RuleLogRecord): Promise<void>;
  load(): Promise<RuleLogRecord[]>;
}

export class MemoryRuleLog implements RuleLog {
  private readonly recs: RuleLogRecord[] = [];
  async append(rec: RuleLogRecord): Promise<void> {
    this.recs.push(structuredClone(rec));
  }
  async load(): Promise<RuleLogRecord[]> {
    return structuredClone(this.recs);
  }
}

/** JSON Lines file. Durable across restarts on one machine; for local runs and demos. */
export class FileRuleLog implements RuleLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  async append(rec: RuleLogRecord): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { encoding: 'utf8', flush: true });
  }
  async load(): Promise<RuleLogRecord[]> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RuleLogRecord);
  }
}
