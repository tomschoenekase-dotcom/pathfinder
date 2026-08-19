import { describe, expect, it } from 'vitest'

import { ANALYTICS_EVENT_TYPES, PUBLIC_ANALYTICS_EVENT_TYPES } from './events'

describe('analytics event trust boundary', () => {
  it('keeps the event catalog unique', () => {
    expect(new Set(ANALYTICS_EVENT_TYPES).size).toBe(ANALYTICS_EVENT_TYPES.length)
  })

  it('does not accept server reliability signals from the public mutation', () => {
    expect(PUBLIC_ANALYTICS_EVENT_TYPES).not.toContain('message.received')
    expect(PUBLIC_ANALYTICS_EVENT_TYPES).not.toContain('message.sent')
    expect(PUBLIC_ANALYTICS_EVENT_TYPES).not.toContain('message.fallback')
    expect(PUBLIC_ANALYTICS_EVENT_TYPES).not.toContain('message.low_confidence')
    for (const eventType of [
      'client_tochi_opened',
      'client_tochi_message_sent',
      'client_tochi_handoff_created',
      'client_tochi_disabled',
      'venue_bot_presentation_changed',
      'character_selected',
      'custom_personality_saved',
      'character_chat_started',
      'character_mode_disabled',
    ] as const) {
      expect(ANALYTICS_EVENT_TYPES).toContain(eventType)
      expect(PUBLIC_ANALYTICS_EVENT_TYPES).not.toContain(eventType as never)
    }
  })
})
