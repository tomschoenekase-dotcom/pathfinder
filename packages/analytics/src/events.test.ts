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
  })
})
