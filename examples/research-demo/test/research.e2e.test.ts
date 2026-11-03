import { afterEach, beforeEach, expect, it } from 'vitest';
import { runVectors } from '@agentevents/contract';
import { checkMappingPurity } from '@agentevents/testkit';
import { RESEARCHER, startLab } from '../src/app';
import { instrumentMapping, paperMapping } from '../src/contract';
import { scriptedResearchAssistant } from '../src/assistant';

let app: Awaited<ReturnType<typeof startLab>>;
beforeEach(async () => {
  app = await startLab({ model: scriptedResearchAssistant, host: { coalesceMs: 50 } });
});
afterEach(async () => app.close());

it('mappings pass their vectors and are pure', async () => {
  for (const m of [instrumentMapping, paperMapping]) {
    expect((await runVectors(m)).every((v) => v.ok)).toBe(true);
    expect(await checkMappingPurity(m)).toMatchObject({ deterministic: true, usedClock: false, usedRandom: false, usedFetch: false });
  }
});

it('configuration: the researcher\'s two requests become approved, live rules', () => {
  expect(app.configuration.map((c) => c.ruleId)).toEqual(['sustained-drift', 'relevant-paper']);
  expect(app.rules.live()).toHaveLength(2);
});

it('thousands of points → a handful of turns; one thread per study builds context; follow-ups use it', async () => {
  for (const phase of app.phases) await app.feed(phase);
  const m = app.host.metrics;
  expect(m.events).toBeGreaterThan(5000);
  expect(m.turns).toBe(3);
  expect(app.decisions.all().some((d) => d.code === 'DEDUPED_L3')).toBe(true);

  const h = await app.host.history('study/study-0042');
  const agentNotes = h.filter((e) => e.kind === 'agent').map((e) => e.text ?? '');
  expect(agentNotes).toHaveLength(3);
  expect(agentNotes[1]).toMatch(/Lamp ageing/u);
  expect(agentNotes[2]).toMatch(/2 earlier finding/u);
  expect(await app.host.history('study/study-0117')).toHaveLength(0); // an isolated outlier never woke the model

  // PII is masked before it is stored in the thread
  expect(JSON.stringify(h)).not.toContain('tech-04@example.org');

  const a1 = await app.host.ask('study/study-0042', "Is this drift consistent with last week's batch?", { asUser: RESEARCHER });
  expect(a1.ok).toBe(true);
  expect(a1.contextEntries).toBe(h.length);
  expect(a1.answer).toMatch(/^No\./u);
  const a2 = await app.host.ask('study/study-0042', 'What next?', { asUser: RESEARCHER });
  expect(a2.contextEntries).toBe(h.length + 2); // the first question and answer are now context
  expect(a2.answer).toMatch(/1 earlier answer/u);

  const refused = await app.host.ask('study/study-0042', 'dump it', { asUser: 'someone@example.org' });
  expect(refused).toMatchObject({ ok: false });
});
