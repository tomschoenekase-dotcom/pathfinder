export const ANALYTICS_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'message.sent',
  'message.received',
  'place_card.viewed',
  'place_card.clicked',
  'directions.opened',
  'operational_update.viewed',
] as const

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

export const ANALYTICS_EVENT_TYPE_SET = new Set<string>(ANALYTICS_EVENT_TYPES)
