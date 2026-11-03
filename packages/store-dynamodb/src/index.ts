import { createHash, randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { EventEnvelope } from '@agentevents/contract';
import type { Decision, DecisionStore, EventLog, RuntimeState, ThreadEntry, ThreadMemory } from '@agentevents/core';
import type { RuleLog, RuleLogRecord } from '@agentevents/rules';

/**
 * DynamoDB adapters for the SDK's store ports (spec §8.1). One table, generic keys:
 *
 *   pk (S), sk (S), expiresAt (N, TTL in epoch seconds)
 *
 * | Store          | pk                       | sk                          |
 * |----------------|--------------------------|-----------------------------|
 * | event log      | LOG#<name>               | HEAD (counter) · E#<offset> |
 * | dedup          | SEEN#<ns>                | sha256(key)                 |
 * | windows        | WIN#<ns>#sha256(key)     | <atMs>#<uuid>               |
 * | decisions      | DEC#<eventId>            | <decidedAt>#<uuid>          |
 * |                | DECDAY#<yyyy-mm-dd>      | <decidedAt>#<uuid>          |
 * | rule log       | RULELOG#<name>           | HEAD (counter) · R#<seq>    |
 * | thread memory  | THREAD#sha256(threadId)  | <at>#<uuid>                 |
 *
 * Offsets are allocated with an atomic counter. Each log assumes ONE writer process (the
 * EventServer's ingest path, the RuleStore); with several concurrent writers a reader could pass an
 * offset before it is written. Use DynamoDB Streams or Kinesis for multi-writer fan-in.
 */

const pad = (n: number): string => String(n).padStart(16, '0');
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const ttlSeconds = (ms: number): number => Math.ceil(ms / 1000);

export interface DynamoStoreOptions {
  doc: DynamoDBDocumentClient;
  table: string;
}

export function documentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } });
}

async function nextSeq(doc: DynamoDBDocumentClient, table: string, pk: string): Promise<number> {
  const r = await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk, sk: 'HEAD' },
      UpdateExpression: 'ADD seq :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(r.Attributes?.['seq']);
}

async function queryAll(doc: DynamoDBDocumentClient, input: QueryCommandInput, max = Number.POSITIVE_INFINITY): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({ ...input, ...(start ? { ExclusiveStartKey: start } : {}) }));
    out.push(...((r.Items ?? []) as Record<string, unknown>[]));
    start = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start && out.length < max);
  return out.slice(0, max);
}

export class DynamoEventLog implements EventLog {
  private readonly pk: string;
  constructor(
    private readonly o: DynamoStoreOptions & { name: string; retentionMs?: number; now?: () => number },
  ) {
    this.pk = `LOG#${o.name}`;
  }

  async append(ev: EventEnvelope): Promise<number> {
    const offset = await nextSeq(this.o.doc, this.o.table, this.pk);
    const now = (this.o.now ?? Date.now)();
    await this.o.doc.send(
      new PutCommand({
        TableName: this.o.table,
        Item: {
          pk: this.pk,
          sk: `E#${pad(offset)}`,
          offset,
          event: ev,
          ...(this.o.retentionMs ? { expiresAt: ttlSeconds(now + this.o.retentionMs) } : {}),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return offset;
  }

  async read(after: number, limit: number): Promise<{ offset: number; event: EventEnvelope }[]> {
    const nowSec = ttlSeconds((this.o.now ?? Date.now)());
    const items = await queryAll(
      this.o.doc,
      {
        TableName: this.o.table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': this.pk, ':from': `E#${pad(after + 1)}`, ':to': 'E#~' },
        Limit: limit,
      },
      limit,
    );
    return items
      .filter((i) => i['expiresAt'] === undefined || Number(i['expiresAt']) > nowSec)
      .map((i) => ({ offset: Number(i['offset']), event: i['event'] as EventEnvelope }));
  }

  async head(): Promise<number> {
    const r = await this.o.doc.send(new GetCommand({ TableName: this.o.table, Key: { pk: this.pk, sk: 'HEAD' }, ConsistentRead: true }));
    return Number(r.Item?.['seq'] ?? 0);
  }

  async oldest(): Promise<number> {
    const [first] = await this.read(0, 1);
    return first?.offset ?? (await this.head()) + 1;
  }
}

export class DynamoRuntimeState implements RuntimeState {
  constructor(private readonly o: DynamoStoreOptions) {}

  async seen(namespace: string, key: string, ttlMs: number, nowMs: number): Promise<boolean> {
    try {
      await this.o.doc.send(
        new PutCommand({
          TableName: this.o.table,
          Item: { pk: `SEEN#${namespace}`, sk: hash(key), expAtMs: nowMs + ttlMs, expiresAt: ttlSeconds(nowMs + ttlMs) },
          ConditionExpression: 'attribute_not_exists(pk) OR expAtMs <= :now',
          ExpressionAttributeValues: { ':now': nowMs },
        }),
      );
      return false;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return true;
      throw e;
    }
  }

  async countInWindow(namespace: string, key: string, atMs: number, windowMs: number): Promise<number> {
    const pk = `WIN#${namespace}#${hash(key)}`;
    await this.o.doc.send(
      new PutCommand({ TableName: this.o.table, Item: { pk, sk: `${pad(atMs)}#${randomUUID()}`, expiresAt: ttlSeconds(atMs + windowMs) } }),
    );
    const r = await this.o.doc.send(
      new QueryCommand({
        TableName: this.o.table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': pk, ':from': pad(atMs - windowMs + 1), ':to': `${pad(atMs)}#~` },
        Select: 'COUNT',
        ConsistentRead: true,
      }),
    );
    return r.Count ?? 0;
  }
}

export class DynamoDecisionStore implements DecisionStore {
  constructor(private readonly o: DynamoStoreOptions & { retentionMs?: number }) {}

  async put(d: Decision): Promise<void> {
    const sk = `${pad(d.decidedAt)}#${randomUUID()}`;
    const ttl = this.o.retentionMs ? { expiresAt: ttlSeconds(d.decidedAt + this.o.retentionMs) } : {};
    const day = new Date(d.decidedAt).toISOString().slice(0, 10);
    await this.o.doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [this.o.table]: [
            { PutRequest: { Item: { pk: `DEC#${d.eventId}`, sk, decision: d, ...ttl } } },
            { PutRequest: { Item: { pk: `DECDAY#${day}`, sk, decision: d, ...ttl } } },
          ],
        },
      }),
    );
  }

  async forEvent(eventId: string): Promise<Decision[]> {
    const items = await queryAll(this.o.doc, {
      TableName: this.o.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `DEC#${eventId}` },
    });
    return items.map((i) => i['decision'] as Decision);
  }

  /** Most recent first, searching back up to `days` daily partitions. */
  async recent(limit: number, days = 7): Promise<Decision[]> {
    const out: Decision[] = [];
    for (let i = 0; i < days && out.length < limit; i++) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const items = await queryAll(
        this.o.doc,
        { TableName: this.o.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `DECDAY#${day}` }, ScanIndexForward: false, Limit: limit - out.length },
        limit - out.length,
      );
      out.push(...items.map((x) => x['decision'] as Decision));
    }
    return out;
  }
}

export class DynamoRuleLog implements RuleLog {
  private readonly pk: string;
  constructor(private readonly o: DynamoStoreOptions & { name: string }) {
    this.pk = `RULELOG#${o.name}`;
  }

  async append(rec: RuleLogRecord): Promise<void> {
    const seq = await nextSeq(this.o.doc, this.o.table, this.pk);
    await this.o.doc.send(
      new PutCommand({ TableName: this.o.table, Item: { pk: this.pk, sk: `R#${pad(seq)}`, rec }, ConditionExpression: 'attribute_not_exists(pk)' }),
    );
  }

  async load(): Promise<RuleLogRecord[]> {
    const items = await queryAll(this.o.doc, {
      TableName: this.o.table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :r)',
      ExpressionAttributeValues: { ':pk': this.pk, ':r': 'R#' },
      ConsistentRead: true,
    });
    return items.map((i) => i['rec'] as RuleLogRecord);
  }
}

export class DynamoThreadMemory implements ThreadMemory {
  constructor(private readonly o: DynamoStoreOptions & { retentionMs?: number }) {}

  async append(threadId: string, entry: ThreadEntry): Promise<void> {
    await this.o.doc.send(
      new PutCommand({
        TableName: this.o.table,
        Item: {
          pk: `THREAD#${hash(threadId)}`,
          sk: `${pad(entry.at)}#${randomUUID()}`,
          entry,
          ...(this.o.retentionMs ? { expiresAt: ttlSeconds(entry.at + this.o.retentionMs) } : {}),
        },
      }),
    );
  }

  async recent(threadId: string, limit: number): Promise<ThreadEntry[]> {
    const items = await queryAll(
      this.o.doc,
      { TableName: this.o.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `THREAD#${hash(threadId)}` }, ScanIndexForward: false, Limit: limit, ConsistentRead: true },
      limit,
    );
    return items.map((i) => i['entry'] as ThreadEntry).reverse();
  }
}

/**
 * Create the table if it does not exist (local development and tests). Production tables belong
 * in infrastructure code (CDK) with point-in-time recovery and deletion protection enabled.
 * Never deletes or modifies an existing table.
 */
export async function ensureTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return;
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
  for (let i = 0; i < 50; i++) {
    const d = await client.send(new DescribeTableCommand({ TableName: table }));
    if (d.Table?.TableStatus === 'ACTIVE') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await client.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } })).catch(() => undefined);
}

/** All four stores on one table. */
export function dynamoStores(o: DynamoStoreOptions & { name: string; logRetentionMs?: number; decisionRetentionMs?: number }) {
  return {
    log: new DynamoEventLog({ ...o, ...(o.logRetentionMs ? { retentionMs: o.logRetentionMs } : {}) }),
    state: new DynamoRuntimeState(o),
    decisions: new DynamoDecisionStore({ ...o, ...(o.decisionRetentionMs ? { retentionMs: o.decisionRetentionMs } : {}) }),
    rules: new DynamoRuleLog(o),
    threads: new DynamoThreadMemory(o),
  };
}
