import { RESEARCHER, startLab } from './app';

import { Verdict } from '@agentevents/contract';
const line = (s = '') => console.log(s);
const scene = (n: number, t: string) => line(`\n━━ ${n}. ${t} ${'━'.repeat(Math.max(0, 70 - t.length))}`);

async function main(): Promise<void> {
  const app = await startLab({
    host: {
      onTurn: (t) => line(`   🤖 turn on ${t.subject} [${t.autonomy}] ${t.eventIds.length} event(s) → ${String(t.result?.['summary'] ?? t.failure)}`),
    },
  });
  line(`agentevents research demo — model: ${process.env['AGENTEVENTS_MODEL'] === 'bedrock' ? 'Claude on Amazon Bedrock' : process.env['AGENTEVENTS_MODEL'] === 'claude' ? 'Claude (direct API, development)' : 'scripted (offline)'}`);

  scene(0, 'Configure: the researcher tells agentevents what counts');
  for (const c of app.configuration) line(`   “${c.request}”\n      → rule ${c.ruleId}: verdict ${c.verdict} · tier ${c.tier}`);
  line('   everything else: stored, searchable, never sent to the model');

  scene(1, 'Thousands of data points arrive; code decides what the model sees');
  const t0 = performance.now();
  let sent = 0;
  const outcomes: Record<string, number> = {};
  for (const phase of app.phases) {
    const f = await app.feed(phase);
    sent += f.sent;
    for (const [k, v] of Object.entries(f.outcomes)) outcomes[k] = (outcomes[k] ?? 0) + v;
    line(`   phase ${phase}: ${f.sent} deliveries`);
  }
  const ms = Math.round(performance.now() - t0);
  line(`   ingested ${sent} deliveries in ${ms} ms: ${JSON.stringify(outcomes)}`);
  const verdicts = app.host.metrics.verdicts;
  const l3 = app.decisions.all().filter((d) => d.code === 'DEDUPED_L3').length;
  line(`   host verdicts: ${JSON.stringify(verdicts)} (near-duplicates merged: ${l3})`);
  const passed = verdicts[Verdict.Wake] ?? 0;
  line(`   ${passed} of ${app.host.metrics.events} events passed the gates (${((passed / app.host.metrics.events) * 100).toFixed(2)}%), coalesced into ${app.host.metrics.turns} model turns`);

  scene(2, 'One thread per study, building context turn by turn');
  for (const study of ['study-0042', 'study-0117']) {
    const h = await app.host.history(`study/${study}`);
    const kinds = h.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
    line(`   study/${study}: ${h.length} entries ${JSON.stringify(kinds)}`);
    for (const e of h.filter((x) => x.kind === 'agent')) line(`      • ${e.text}`);
  }

  scene(3, 'The researcher asks follow-ups in the thread; context is already loaded');
  const q1 = await app.host.ask('study/study-0042', "Is this drift consistent with last week's batch?", { asUser: RESEARCHER });
  line(`   Q: Is this drift consistent with last week's batch?  (context: ${q1.contextEntries} entries; tools: ${q1.toolCalls.map((c) => c.name).join(', ')})`);
  line(`   A: ${q1.answer}`);
  const q2 = await app.host.ask('study/study-0042', 'So what should I do before re-running B-7?', { asUser: RESEARCHER });
  line(`   Q: So what should I do before re-running B-7?  (context: ${q2.contextEntries} entries)`);
  line(`   A: ${q2.answer}`);
  const intruder = await app.host.ask('study/study-0042', 'Show me everything', { asUser: 'someone@example.org' });
  line(`   someone else asking: ${intruder.reason}`);

  await app.close();
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
