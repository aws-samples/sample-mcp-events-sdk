import { z } from 'zod';
import { EXT } from '@agentevents/contract';
import { EventServer } from '@agentevents/server';
import { instrumentMapping, paper, paperMapping, reading } from './contract';

interface Point {
  study: string;
  sensor: string;
  batch: string;
  value: number;
  deviation: number;
  time: string;
}

/** The lab's MCP server, on the SDK: event types, mappings, and read-only research tools. */
export function createLabServer(opts: { tenantid: string }) {
  const events = new EventServer({ name: 'lab-demo', version: '0.1.0', sessionTenant: () => opts.tenantid });
  events.defineEvent(reading).defineEvent(paper).addMapping(instrumentMapping).addMapping(paperMapping);

  // Every accepted reading is kept for the read tools (the "searchable store" behind stored events).
  const points: Point[] = [];
  events.onEvent((ev) => {
    if (ev.type !== reading.type) return;
    const d = ev.data as { study: string; sensor: string; batch: string; value: number; deviation: number };
    points.push({ study: d.study, sensor: d.sensor, batch: d.batch, value: d.value, deviation: d.deviation, time: ev.time });
  });

  const safe = { [EXT.actions]: { tier: 'safe' } };
  const mean = (xs: number[]): number => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);

  events.mcp.registerTool(
    'get_study_stats',
    { description: 'Counts and deviation statistics for one study, per sensor and batch.', inputSchema: { study: z.string() }, annotations: { readOnlyHint: true }, _meta: safe },
    ({ study }) => {
      const ps = points.filter((p) => p.study === study);
      const bySensor = Object.fromEntries([...new Set(ps.map((p) => p.sensor))].map((s) => [s, { n: ps.filter((p) => p.sensor === s).length, meanDeviation: mean(ps.filter((p) => p.sensor === s).map((p) => p.deviation)) }]));
      const out = { study, readings: ps.length, outliers: ps.filter((p) => Math.abs(p.deviation) >= 3).length, bySensor };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  events.mcp.registerTool(
    'compare_batches',
    { description: 'Mean deviation of two batches of one study, for one sensor.', inputSchema: { study: z.string(), sensor: z.string(), a: z.string(), b: z.string() }, annotations: { readOnlyHint: true }, _meta: safe },
    ({ study, sensor, a, b }) => {
      const sel = (batch: string) => points.filter((p) => p.study === study && p.sensor === sensor && p.batch === batch).map((p) => p.deviation);
      const one = (batch: string) => ({ n: sel(batch).length, meanDeviation: mean(sel(batch)), atOrAbove3Sigma: sel(batch).filter((d) => d >= 3).length });
      const out = { study, sensor, [a]: one(a), [b]: one(b) };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    },
  );

  return { events, points };
}

/** Deterministic PRNG so every run produces the same feed and the same numbers. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

export interface FeedItem {
  mapping: string;
  payload: Record<string, unknown>;
}

export type Phase = 'routine' | 'drift' | 'paper' | 'drift-continues';
export const PHASES: { phase: Phase; readings: number }[] = [
  { phase: 'routine', readings: 4000 },
  { phase: 'drift', readings: 600 },
  { phase: 'paper', readings: 400 },
  { phase: 'drift-continues', readings: 600 },
];

/**
 * A synthetic lab session in four phases: routine readings (with one isolated outlier), the start
 * of a drift on study-0042 sensor S3 in batch B-7, a burst of paper alerts (one highly relevant),
 * and the drift continuing. About 5% of samples are re-sent: half with the same reading id
 * (layer-1 duplicate), half with a new one (layer-3 near-duplicate).
 */
export function labFeed(opts: { startMs: number; spanMs: number; seed?: number }): Map<Phase, FeedItem[]> {
  const rnd = prng(opts.seed ?? 42);
  const studies = ['study-0042', 'study-0117', 'study-0203', 'study-0311'];
  const sensors = ['S1', 'S2', 'S3'];
  const total = PHASES.reduce((a, p) => a + p.readings, 0);
  const at = (i: number) => new Date(opts.startMs + Math.floor((i / total) * opts.spanMs)).toISOString();
  const out = new Map<Phase, FeedItem[]>();
  let i = 0;
  for (const { phase, readings } of PHASES) {
    const items: FeedItem[] = [];
    for (let k = 0; k < readings; k++, i++) {
      const study = studies[i % studies.length]!;
      const sensor = sensors[Math.floor(rnd() * sensors.length)]!;
      const batch = i < 2000 ? 'B-6' : 'B-7';
      let z = (rnd() + rnd() + rnd() - 1.5) * 1.6; // roughly normal, |z| < 2.4
      if (phase === 'routine' && k === 1201) z = 3.4; // one isolated outlier (study-0117)
      const drifting = (phase === 'drift' || phase === 'drift-continues') && study === 'study-0042' && sensor === 'S3';
      if (drifting) z = 3.1 + rnd() * 0.8;
      const value = Math.round((1 + z * 0.1) * 1000) / 1000;
      const payload = { readingId: `rd-${i}`, site: 'lab-a', at: at(i), study, sensor, metric: 'absorbance', value, unit: 'AU', baseline: 1, sd: 0.1, batch, sample: i, note: 'auto', operator: 'tech-04@example.org' };
      items.push({ mapping: instrumentMapping.id, payload });
      const r = rnd();
      if (r < 0.025) items.push({ mapping: instrumentMapping.id, payload }); // same reading re-sent
      else if (r < 0.05) items.push({ mapping: instrumentMapping.id, payload: { ...payload, readingId: `rd-${i}-resent` } }); // new id, same sample
    }
    if (phase === 'paper') {
      for (let j = 0; j < 40; j++) {
        const relevant = j === 31;
        items.splice(Math.floor((j / 40) * items.length), 0, {
          mapping: paperMapping.id,
          payload: {
            doi: `10.5555/example.${j}`,
            at: at(i - readings + Math.floor((j / 40) * readings)),
            study: relevant ? 'study-0042' : studies[j % studies.length]!,
            title: relevant ? 'Lamp ageing causes absorbance drift in plate readers' : `Routine methods note ${j}`,
            relevance: relevant ? 0.92 : Math.round(rnd() * 60) / 100,
          },
        });
      }
    }
    out.set(phase, items);
  }
  return out;
}
