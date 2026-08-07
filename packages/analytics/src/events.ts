export const ANALYTICS_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'message.sent',
  'message.received',
  // Server-only reliability signal. Emitted when guest chat returns the canned
  // fail-open response after generation fails; never accepted from public clients.
  'message.fallback',
  // Internal-only signal: retrieval was semantically far from the question (or the
  // reply matched a "no-info" pattern). Never surfaced to guests; powers content-gap
  // analytics. Emitted best-effort from chat.send, like the other message events.
  'message.low_confidence',
  'place_card.viewed',
  'place_card.clicked',
  'directions.opened',
  'operational_update.viewed',
  'venue.updated',
  'engagement_question.asked',
] as const

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

export const ANALYTICS_EVENT_TYPE_SET = new Set<string>(ANALYTICS_EVENT_TYPES)

// Only browser-origin interaction signals belong in the public analytics mutation.
// Response, fallback, low-confidence, engagement, and venue-update events are emitted
// by trusted server paths so operational metrics cannot be forged by a guest.
export const PUBLIC_ANALYTICS_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'message.sent',
  'place_card.viewed',
  'place_card.clicked',
  'directions.opened',
  'operational_update.viewed',
] as const satisfies readonly AnalyticsEventType[]

export type PublicAnalyticsEventType = (typeof PUBLIC_ANALYTICS_EVENT_TYPES)[number]
