import type { EventTypeDef, Mapping } from '@agentevents/contract';
import type { Rule } from '@agentevents/core';

import { Autonomy, MaskMode, MidTurn, Sensitivity, Verdict, FilterLanguage } from '@agentevents/contract';
/** Published contract for the research example. Names and values are fictional. */
const BASE = 'https://events.example.org/schemas/lab';

export const reading: EventTypeDef = {
  type: 'org.example.lab.reading.v1',
  version: '1.0.0',
  title: 'Instrument reading',
  dataschema: `${BASE}/reading/1.0.0.json`,
  schema: {
    type: 'object',
    required: ['study', 'sensor', 'metric', 'value', 'deviation', 'batch'],
    properties: {
      study: { type: 'string', 'x-event': { filterable: true } },
      sensor: { type: 'string', 'x-event': { filterable: true } },
      metric: { type: 'string', 'x-event': { filterable: true } },
      value: { type: 'number', 'x-event': { filterable: true } },
      unit: { type: 'string' },
      /** Distance from the study baseline in standard deviations. */
      deviation: { type: 'number', 'x-event': { filterable: true } },
      batch: { type: 'string', 'x-event': { filterable: true } },
      /** The instrument's own sample counter; a re-sent sample keeps it. */
      sample: { type: 'number' },
      note: { type: 'string', 'x-event': { untrusted: true } },
      operator: { type: 'string', 'x-event': { sensitivity: Sensitivity.Pii, mask: MaskMode.Hash } },
    },
  },
  hints: { suggestedVerdict: Verdict.Store, midTurn: MidTurn.Merge, coalesce: { by: ['subject'], windowSeconds: 1, max: 12 } },
};

export const paper: EventTypeDef = {
  type: 'org.example.lab.paper.v1',
  version: '1.0.0',
  title: 'New paper',
  dataschema: `${BASE}/paper/1.0.0.json`,
  schema: {
    type: 'object',
    required: ['study', 'doi', 'title', 'relevance'],
    properties: {
      study: { type: 'string', 'x-event': { filterable: true } },
      doi: { type: 'string' },
      title: { type: 'string', 'x-event': { untrusted: true } },
      relevance: { type: 'number', 'x-event': { filterable: true } },
    },
  },
  hints: { suggestedVerdict: Verdict.Store, midTurn: MidTurn.Merge, coalesce: { by: ['subject'], windowSeconds: 1, max: 5 } },
};

export const instrumentMapping: Mapping = {
  id: 'instrument->lab.reading',
  version: '1.0.0',
  source: { system: 'lab-instruments', schema: 'reading-push', version: '1' },
  target: { type: reading.type },
  upstreamId: 'readingId',
  sourceUri: '"instruments.example.org/" & site',
  // Near-duplicates: an instrument re-sending a sample under a new reading id (layer 1 can't see it).
  dedupKey: { fields: ['data.study', 'data.sensor', 'data.sample'], windowSeconds: 600 },
  transform: {
    language: FilterLanguage.Jsonata,
    expression: `{
      "time": at,
      "subject": "study/" & study,
      "partitionkey": "study/" & study,
      "data": { "study": study, "sensor": sensor, "metric": metric, "value": value, "unit": unit,
                "deviation": $round((value - baseline) / sd, 2), "batch": batch, "sample": sample, "note": note, "operator": operator }
    }`,
  },
  vectors: [
    {
      name: 'reading',
      input: { readingId: 'r1', site: 'lab-a', at: '2026-11-02T10:00:00Z', study: 'study-0042', sensor: 'S3', metric: 'absorbance', value: 1.3, unit: 'AU', baseline: 1.0, sd: 0.1, batch: 'B-7', sample: 9, note: 'ok', operator: 'tech@example.org' },
      expect: {
        time: '2026-11-02T10:00:00Z',
        subject: 'study/study-0042',
        partitionkey: 'study/study-0042',
        data: { study: 'study-0042', sensor: 'S3', metric: 'absorbance', value: 1.3, unit: 'AU', deviation: 3, batch: 'B-7', sample: 9, note: 'ok', operator: 'tech@example.org' },
      },
    },
  ],
};

export const paperMapping: Mapping = {
  id: 'papers->lab.paper',
  version: '1.0.0',
  source: { system: 'paper-alerts', schema: 'alert', version: '1' },
  target: { type: paper.type },
  upstreamId: 'doi',
  sourceUri: '"papers.example.org"',
  transform: {
    language: FilterLanguage.Jsonata,
    expression: '{ "time": at, "subject": "study/" & study, "data": { "study": study, "doi": doi, "title": title, "relevance": relevance } }',
  },
  vectors: [
    {
      name: 'paper',
      input: { doi: '10.5555/example.1', at: '2026-11-02T10:00:00Z', study: 'study-0042', title: 'A title', relevance: 0.9 },
      expect: { time: '2026-11-02T10:00:00Z', subject: 'study/study-0042', data: { study: 'study-0042', doi: '10.5555/example.1', title: 'A title', relevance: 0.9 } },
    },
  ],
};

/** Code decides what reaches the model. Everything else is stored, searchable, never paid for. */
export const RULES: Rule[] = [
  {
    id: 'sustained-drift',
    version: 1,
    priority: 10,
    description: 'Wake when one study sees 3+ readings at >= 3 sigma within 10 minutes',
    types: [reading.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'data.deviation': [{ numeric: ['>=', 3] }] } },
    window: { operator: 'threshold', count: 3, windowSeconds: 600, by: 'subject' },
    verdict: Verdict.Wake,
    autonomy: Autonomy.Investigate,
  },
  {
    id: 'relevant-paper',
    version: 1,
    priority: 20,
    description: 'Wake for papers scored highly relevant to a study',
    types: [paper.type],
    filter: { language: FilterLanguage.EbPattern, expression: { 'data.relevance': [{ numeric: ['>=', 0.85] }] } },
    verdict: Verdict.Wake,
    autonomy: Autonomy.Investigate,
  },
];

/** What the researcher asks for, in their own words; each becomes the structured rule above. */
export const CONFIG_REQUESTS: Record<string, string> = {
  'sustained-drift': 'Tell me when a study drifts: three readings past three standard deviations within ten minutes.',
  'relevant-paper': 'And when a new paper is highly relevant to one of my studies.',
};
