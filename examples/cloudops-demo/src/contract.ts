import type { EventTypeDef, JsonSchema, Mapping } from '@agentevents/contract';
import type { SituationConfig } from '@agentevents/core';

/** The published contract for the CloudOps example: schemas, mapping, situation config. */

export const SCHEMA_BASE = 'https://events.example.com/schemas/ops';
export const PLATFORM_PRINCIPAL = 'arn:aws:iam::111122223333:role/agentevents-ops-agent';

const alarmData: JsonSchema = {
  type: 'object',
  required: ['alarm', 'service', 'env', 'state', 'severity'],
  properties: {
    alarm: { type: 'string', 'x-event': { filterable: true, stability: 'stable' } },
    service: { type: 'string', 'x-event': { filterable: true, stability: 'stable' } },
    env: { type: 'string', enum: ['prod', 'staging', 'dev'], 'x-event': { filterable: true, enumClosed: true } },
    state: { type: 'string', enum: ['ALARM', 'OK'], 'x-event': { filterable: true, enumClosed: true } },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], 'x-event': { filterable: true, enumClosed: true } },
    metric: { type: 'string', 'x-event': { filterable: true } },
    value: { type: 'number', 'x-event': { filterable: true } },
    threshold: { type: 'number' },
    description: { type: 'string', 'x-event': { untrusted: true } },
    onCallEmail: { type: 'string', 'x-event': { sensitivity: 'pii', mask: 'hash' } },
  },
};

/** Raw alarm state changes. Internal: ingested and logged, not listed to clients. */
export const alarmState: EventTypeDef = {
  type: 'com.example.ops.alarm_state.v1',
  version: '1.0.0',
  title: 'Alarm state changed',
  dataschema: `${SCHEMA_BASE}/alarm_state/1.0.0.json`,
  schema: alarmData,
  latencyP99Seconds: 60,
};

/** The agent-facing stateful situation (spec E2). */
export const alarmSituation: EventTypeDef = {
  type: 'com.example.ops.alarm.v1',
  version: '1.0.0',
  title: 'Alarm situation',
  dataschema: `${SCHEMA_BASE}/alarm/1.0.0.json`,
  schema: alarmData,
  situation: true,
  latencyP99Seconds: 60,
  hints: {
    suggestedVerdict: 'wake',
    midTurn: 'merge',
    coalesce: { by: ['subject'], windowSeconds: 1, max: 20 },
    replyTools: ['describe_service', 'get_alarm_history', 'restart_service'],
    priority: 'high',
    deadlineSeconds: 120,
  },
};

export const alarmStorm: EventTypeDef = {
  type: 'com.example.ops.alarm_storm.v1',
  version: '1.0.0',
  title: 'Alarm storm roll-up',
  dataschema: `${SCHEMA_BASE}/alarm_storm/1.0.0.json`,
  schema: {
    type: 'object',
    properties: {
      memberType: { type: 'string', 'x-event': { filterable: true } },
      openedInWindow: { type: 'number', 'x-event': { filterable: true } },
      members: { type: 'number', 'x-event': { filterable: true } },
    },
  },
  situation: true,
  hints: { suggestedVerdict: 'wake', midTurn: 'queue', coalesce: { by: ['subject'], windowSeconds: 1, max: 1 } },
};

/** Monitoring webhook payload → contract. Upstream id drives L1 dedup and the deterministic `id`. */
export const monitoringMapping: Mapping = {
  id: 'monitoring.alarm->ops.alarm_state',
  version: '1.0.0',
  source: { system: 'monitoring', schema: 'alarm-webhook', version: '2026-01' },
  target: { type: alarmState.type },
  upstreamId: 'eventId',
  sourceUri: '"monitoring.example.com/" & account & "/" & region',
  transform: {
    language: 'jsonata',
    expression: `{
      "time": time,
      "subject": "service/" & alarm.service,
      "partitionkey": "service/" & alarm.service,
      "actor": { "kind": "service", "principal": changedBy },
      "causationid": causation,
      "data": {
        "alarm": alarm.name, "service": alarm.service, "env": alarm.env, "state": alarm.state,
        "severity": alarm.severity, "metric": alarm.metric, "value": alarm.value,
        "threshold": alarm.threshold, "description": alarm.description, "onCallEmail": alarm.onCall
      }
    }`,
  },
  vectors: [
    {
      name: 'latency alarm',
      input: {
        eventId: 'evt-1', account: '111122223333', region: 'us-east-1', time: '2026-11-02T10:00:00Z',
        changedBy: 'monitoring.amazonaws.com',
        alarm: { name: 'checkout-api-p99', service: 'checkout-api', env: 'prod', state: 'ALARM', severity: 'high', metric: 'p99_latency_ms', value: 2300, threshold: 1000, description: 'p99 above 1s', onCall: 'oncall@example.com' },
      },
      expect: {
        time: '2026-11-02T10:00:00Z',
        subject: 'service/checkout-api',
        partitionkey: 'service/checkout-api',
        actor: { kind: 'service', principal: 'monitoring.amazonaws.com' },
        data: { alarm: 'checkout-api-p99', service: 'checkout-api', env: 'prod', state: 'ALARM', severity: 'high', metric: 'p99_latency_ms', value: 2300, threshold: 1000, description: 'p99 above 1s', onCallEmail: 'oncall@example.com' },
      },
    },
  ],
};

export const situationConfig: SituationConfig = {
  inputType: alarmState.type,
  outputType: alarmSituation.type,
  outputSource: 'ops.example.com/situations',
  groupBy: ['data.alarm'],
  stateField: 'data.state',
  openStates: ['ALARM'],
  resolveStates: ['OK'],
  severityField: 'data.severity',
  flapping: { flips: 4, windowSeconds: 600 },
  storm: { openThreshold: 4, windowSeconds: 120, stormType: alarmStorm.type },
};
