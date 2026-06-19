export const ANALYTICS_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'message.sent',
  'message.received',
  // Internal-only signal: retrieval was semantically far from the question (or the
  // reply matched a "no-info" pattern). Never surfaced to guests; powers content-gap
  // analytics. Emitted best-effort from chat.send, like the other message events.
  'message.low_confidence',
  'place_card.viewed',
  'place_card.clicked',
  'directions.opened',
  'operational_update.viewed',
  'venue.updated',
] as const

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

export const ANALYTICS_EVENT_TYPE_SET = new Set<string>(ANALYTICS_EVENT_TYPES)
