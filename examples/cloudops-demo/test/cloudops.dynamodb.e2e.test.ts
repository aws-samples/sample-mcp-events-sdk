import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import dynalite from 'dynalite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Proposal } from '@agentevents/actions';
import { readAll } from '@agentevents/core';
import { documentClient, dynamoStores, ensureTable } from '@agentevents/store-dynamodb';
import { OWNER, alarmPayload, sendWebhook, startApp, type AppStores } from '../src/app';
import { scriptedInvestigator } from '../src/agent';

let server: Server;
let client: DynamoDBClient;

beforeAll(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${port}`, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  await ensureTable(client, 'cloudops');
});
afterAll(async () => {
  client.destroy();
  await new Promise((r) => server.close(r));
});

function stores(): AppStores {
  const doc = documentClient(client);
  const s = dynamoStores({ doc, table: 'cloudops', name: 'acme' });
  return { serverLog: s.log, serverState: s.state, hostState: s.state, decisions: s.decisions, ruleLog: s.rules };
}

it('runs the governed loop on DynamoDB and keeps state across a restart', async () => {
  const proposals: Proposal[] = [];
  let t = Date.now() - 20 * 60_000;
  const next = (): string => new Date((t += 150_000)).toISOString();
  const settle = async (a: { host: { settle(): Promise<void> } }) => {
    await new Promise((r) => setTimeout(r, 100));
    await a.host.settle();
  };

  // ---- first process
  const a = await startApp({ model: scriptedInvestigator, stores: stores(), host: { onProposal: (p) => proposals.push(p), coalesceMs: 50 } });
  const first = alarmPayload({ service: 'checkout-api', time: next() });
  expect((await sendWebhook(a, first)).status).toBe(202);
  await settle(a);
  expect(a.host.turns).toHaveLength(1);
  const p = proposals[0]!;
  expect((await a.host.decide(p.proposalId, p.fingerprint, 'approve', OWNER.id)).ok).toBe(true);
  await settle(a);
  const decisionsA = await a.allDecisions();
  expect(decisionsA.at(-1)).toMatchObject({ code: 'LOOP' });

  const change = (await a.rulesClient.callTool({
    name: 'rules_propose',
    arguments: { op: 'upsert', request: 'digest medium prod alarms', rule: { id: 'prod-medium-digest', priority: 15, description: 'digest medium', types: ['com.example.ops.alarm.v1'], filter: { language: 'eb-pattern', expression: { 'situation.severity': ['medium'] } }, verdict: 'digest' } },
  })).structuredContent as { changeId: string; fingerprint: string };
  await a.rulesClient.callTool({ name: 'rules_backtest', arguments: { changeId: change.changeId } });
  expect((await a.rulesClient.callTool({ name: 'rules_approve', arguments: change })).isError).toBeFalsy();
  await a.rulesClient.callTool({ name: 'rules_deploy', arguments: { changeId: change.changeId, mode: 'live' } });
  const logged = (await readAll(stores().serverLog!)).length;
  await a.close();

  // ---- restart: a fresh process on the same table
  const b = await startApp({ model: scriptedInvestigator, stores: stores(), host: { coalesceMs: 50 } });
  expect(b.rules.live().some((r) => r.id === 'prod-medium-digest')).toBe(true); // rule store survived
  expect((await sendWebhook(b, first, { id: 'redelivered-after-restart' })).body).toMatchObject({ code: 'DEDUPED_L1' }); // dedup survived
  expect((await readAll(stores().serverLog!)).length).toBe(logged); // event log survived, nothing re-appended
  await sendWebhook(b, alarmPayload({ service: 'cart', severity: 'medium', time: next() }));
  await settle(b);
  const last = (await b.allDecisions()).filter((d) => d.subject === 'service/cart').at(-1);
  expect(last).toMatchObject({ verdict: 'digest', ruleId: 'prod-medium-digest' });
  expect((await b.allDecisions()).length).toBeGreaterThan(decisionsA.length); // decision records survived
  await b.close();
});
