// Fixed topic taxonomy for guest questions. Single source of truth shared by the
// nightly classifier prompt (apps/workers) and the dashboard labels (via the API).
// Single-label per question; 'other' when nothing fits. EDITABLE — adjust the keys
// and labels together and the classifier/dashboard stay in sync.
export const TOPIC_TAXONOMY = [
  { key: 'directions_navigation', label: 'Directions & navigation' },
  { key: 'amenities_restrooms', label: 'Amenities & restrooms' },
  { key: 'food_drink', label: 'Food & drink' },
  { key: 'hours_logistics', label: 'Hours & logistics' },
  { key: 'tickets_pricing', label: 'Tickets & pricing' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'history_meaning', label: 'History & meaning' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'events_today', label: 'Events today' },
  { key: 'other', label: 'Other' },
] as const

export type TopicKey = (typeof TOPIC_TAXONOMY)[number]['key']

export const TOPIC_KEYS = TOPIC_TAXONOMY.map((topic) => topic.key) as TopicKey[]

export const TOPIC_KEY_SET = new Set<string>(TOPIC_KEYS)

export const TOPIC_LABELS: Record<TopicKey, string> = TOPIC_TAXONOMY.reduce(
  (acc, topic) => {
    acc[topic.key] = topic.label
    return acc
  },
  {} as Record<TopicKey, string>,
)
