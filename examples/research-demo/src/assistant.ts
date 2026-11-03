import { scriptedModel, type Model } from '@agentevents/host';

interface Rendered {
  data: Record<string, unknown>;
}

function events(prompt: string): Rendered[] {
  const out: Rendered[] = [];
  for (const m of prompt.matchAll(/<event [^>]*>\n(.*)\n<\/event nonce="[0-9a-f]+">/gu)) {
    try {
      out.push(JSON.parse(m[1]!) as Rendered);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Earlier agent notes and Q&A in the thread history, decoded from their quoted JSON strings. */
function notes(prompt: string, who: string): string[] {
  return [...prompt.matchAll(new RegExp(`^- ${who}: (".*")$`, 'gmu'))].map((m) => JSON.parse(m[1]!) as string);
}

const result = (r: Record<string, unknown>): string => `\`\`\`result\n${JSON.stringify(r)}\n\`\`\``;

/**
 * Offline stand-in for an LLM research assistant. It reads the thread history the host provides,
 * so its answers visibly build on what the thread already knows.
 */
export const scriptedResearchAssistant: Model = scriptedModel('scripted-research-assistant', async (req, call) => {
  const asked = /asks: "(.*)"$/mu.exec(req.prompt)?.[1];
  const all = events(req.prompt);
  const study = String([...all].reverse().find((e) => e.data['study'])?.data['study'] ?? 'study-0042');
  const earlier = notes(req.prompt, 'agent \\(earlier turn\\)');

  if (asked) {
    const prior = notes(req.prompt, 'assistant answered');
    if (/batch/iu.test(asked)) {
      const cmp = await call('compare_batches', { study, sensor: 'S3', a: 'B-6', b: 'B-7' });
      const c = JSON.parse(cmp.content) as Record<string, { n: number; meanDeviation: number; atOrAbove3Sigma: number }>;
      const a = c['B-6']!;
      const b = c['B-7']!;
      return (
        `${b.atOrAbove3Sigma > a.atOrAbove3Sigma ? 'No' : 'Yes'}. On ${study} sensor S3, batch B-6 had ${a.atOrAbove3Sigma} of ${a.n} readings at ≥3σ; ` +
        `B-7 has ${b.atOrAbove3Sigma} of ${b.n}. This thread already holds ${earlier.length} finding(s); the first was: "${earlier[0] ?? 'none'}"`
      );
    }
    return (
      `Building on ${prior.length} earlier answer(s) and ${earlier.length} finding(s) in this thread: ` +
      `the drift is limited to S3 in batch B-7, and the paper flagged here (lamp ageing) fits that pattern. ` +
      `Next: check the lamp hours on that reader before re-running B-7.`
    );
  }

  // Only the events of THIS turn (after the history block) decide what kind of turn it is.
  const fresh = events(req.prompt.split(/coalesced into this turn|Thread history[^\n]*\n(?:.*\n)*?(?=<event)/u).at(-1) ?? req.prompt);
  const p = fresh.find((e) => e.data['doi']) ?? (all.at(-1)?.data['doi'] ? all.at(-1) : undefined);
  if (p) {
    return result({
      summary: `Relevant paper for ${study}: "${String(p.data['title'])}" (${String(p.data['doi'])}, relevance ${String(p.data['relevance'])})`,
      cause: 'A paper scored highly relevant to this study arrived.',
      nextStep: earlier.length ? `Compare it with the ${earlier.length} drift finding(s) already in this thread.` : 'Read the abstract.',
    });
  }

  const stats = await call('get_study_stats', { study });
  const s = JSON.parse(stats.content) as { readings: number; outliers: number; bySensor: Record<string, { meanDeviation: number }> };
  const drifting = all.filter((e) => Number(e.data['deviation']) >= 3);
  const sensor = String(drifting[0]?.data['sensor'] ?? 'S3');
  return result({
    summary: `Sustained drift on ${study} sensor ${sensor}: ${drifting.length} readings at ≥3σ in this window (${s.outliers} outliers in ${s.readings} readings so far)`,
    cause: `Sensor ${sensor} mean deviation is ${s.bySensor[sensor]?.meanDeviation ?? '?'}σ; the other sensors stay near baseline.`,
    evidence: [`get_study_stats: ${stats.content}`],
    nextStep: earlier.length ? `Still drifting; ${earlier.length} earlier finding(s) in this thread.` : 'Check whether this batch differs from the previous one.',
  });
});
