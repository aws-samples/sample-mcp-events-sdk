import { z } from 'zod';
import { EventEnvelope } from './envelope';
import { EXT } from './ns';
import { DeliveryMode, DeliveryStatus } from './vocab';
import type { FilterSpec } from './filter';

/**
 * SEP-3415 wire shapes. Method and field names follow the PR as of 2026-10-28; companion data
 * rides in `_meta` so SEP-3415-only peers still interoperate (spec §1.2).
 */
export const METHODS = {
  list: 'events/list',
  poll: 'events/poll',
  stream: 'events/stream',
  occurrence: 'notifications/events/occurrence',
  heartbeat: 'notifications/events/heartbeat',
} as const;

export const Occurrence = z.object({
  eventId: z.string(),
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type Occurrence = z.infer<typeof Occurrence>;

export function toOccurrence(ev: EventEnvelope): Occurrence {
  const { data, ...envelope } = ev;
  return { eventId: ev.id, name: ev.type, data, _meta: { [EXT.contract]: { envelope } } };
}

/** Rebuild the envelope from an occurrence. Returns undefined for SEP-3415-only occurrences. */
export function fromOccurrence(o: Occurrence): EventEnvelope | undefined {
  const meta = o._meta?.[EXT.contract] as { envelope?: unknown } | undefined;
  if (!meta?.envelope) return undefined;
  const parsed = EventEnvelope.safeParse({ ...(meta.envelope as object), data: o.data });
  return parsed.success ? parsed.data : undefined;
}

const FilterMeta = z
  .object({ [EXT.contract]: z.object({ filter: z.custom<FilterSpec>().optional() }).optional() })
  .passthrough()
  .optional();

export const ListRequest = z.object({
  method: z.literal(METHODS.list),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

export const PollRequest = z.object({
  method: z.literal(METHODS.poll),
  params: z
    .object({
      names: z.array(z.string()).min(1),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().positive().max(500).optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      _meta: FilterMeta,
    })
    .passthrough(),
});

export const StreamRequest = z.object({
  method: z.literal(METHODS.stream),
  params: z
    .object({
      names: z.array(z.string()).min(1),
      cursor: z.string().nullable().optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      _meta: FilterMeta,
    })
    .passthrough(),
});

export const EventTypeEntry = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    payloadSchema: z.record(z.string(), z.unknown()),
    delivery: z.array(z.enum(DeliveryMode)),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type EventTypeEntry = z.infer<typeof EventTypeEntry>;

export const ListResult = z.object({ events: z.array(EventTypeEntry), nextCursor: z.string().optional() }).passthrough();

export const PollResult = z
  .object({
    events: z.array(Occurrence),
    cursor: z.string(),
    truncated: z.boolean(),
    hasMore: z.boolean(),
    nextPollMs: z.number().int().nonnegative(),
    missedCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type PollResult = z.infer<typeof PollResult>;

export const StreamResult = z.object({ subscriptionId: z.string(), cursor: z.string() }).passthrough();

export const OccurrenceNotification = z.object({
  method: z.literal(METHODS.occurrence),
  params: z.object({ subscriptionId: z.string(), cursor: z.string(), event: Occurrence }).passthrough(),
});

export const HeartbeatNotification = z.object({
  method: z.literal(METHODS.heartbeat),
  params: z.object({ subscriptionId: z.string(), cursor: z.string() }).passthrough(),
});

export const filterFromMeta = (meta: unknown): FilterSpec | undefined =>
  (meta as Record<string, { filter?: FilterSpec } | undefined> | undefined)?.[EXT.contract]?.filter;

// ---- SEP-3415 webhook delivery ----------------------------------------------------------------

export const WEBHOOK_METHODS = { subscribe: 'events/subscribe', unsubscribe: 'events/unsubscribe' } as const;

export const LastError = z.object({
  category: z.enum(['challenge_failed', 'url_rejected', 'delivery_failed', 'redirect', 'timeout', 'expired']),
  at: z.string(),
  attempts: z.number().int().optional(),
});
export type LastError = z.infer<typeof LastError>;

export const SubscribeRequest = z.object({
  method: z.literal(WEBHOOK_METHODS.subscribe),
  params: z
    .object({
      /** Present to refresh (extend TTL) or rotate an existing subscription. */
      subscriptionId: z.string().optional(),
      names: z.array(z.string()).min(1).optional(),
      url: z.string().url().optional(),
      /** Standard Webhooks secret (`whsec_...`) chosen by the client. Sending a new one rotates. */
      secret: z.string().startsWith('whsec_').optional(),
      ttlMs: z.number().int().positive().optional(),
      cursor: z.string().nullable().optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

export const SubscribeResult = z
  .object({
    subscriptionId: z.string(),
    /** Granted TTL; authoritative (spec amendment A2). */
    ttlMs: z.number().int(),
    /** Advisory wall-clock time to refresh by. */
    refreshBefore: z.string(),
    deliveryStatus: z.enum(DeliveryStatus),
    lastError: LastError.optional(),
    cursor: z.string(),
  })
  .passthrough();
export type SubscribeResult = z.infer<typeof SubscribeResult>;

export const UnsubscribeRequest = z.object({
  method: z.literal(WEBHOOK_METHODS.unsubscribe),
  params: z.object({ subscriptionId: z.string() }).passthrough(),
});

/** Body of a webhook POST. `type: challenge` is sent once on subscribe; the endpoint echoes it. */
export const WebhookBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('challenge'), subscriptionId: z.string(), challenge: z.string() }),
  z.object({ type: z.literal('event'), subscriptionId: z.string(), cursor: z.string(), event: Occurrence }),
]);
export type WebhookBody = z.infer<typeof WebhookBody>;
