import { describe, expect, it } from 'vitest'

import { DeleteVenueInput, UpdateVenueAiConfigInput, UpdateVenueChatDesignInput } from './venue'

const id = 'cm00000000000000000000001'
const revision = '2026-08-11T14:30:00.000Z'

describe('venue mutation CAS schemas', () => {
  it.each([
    [UpdateVenueAiConfigInput, { venueId: id, tonePreset: 'concise' }],
    [UpdateVenueChatDesignInput, { venueId: id, chatTheme: 'dark' }],
    [DeleteVenueInput, { id }],
  ] as const)('rejects a mutation without revision authority', (schema, input) => {
    expect(schema.safeParse(input).success).toBe(false)
  })

  it.each([
    [UpdateVenueAiConfigInput, { venueId: id, expectedUpdatedAt: revision, tonePreset: 'concise' }],
    [UpdateVenueChatDesignInput, { venueId: id, expectedUpdatedAt: revision, chatTheme: 'dark' }],
    [DeleteVenueInput, { id, expectedUpdatedAt: revision }],
  ] as const)('coerces expectedUpdatedAt to the exact Date boundary', (schema, input) => {
    const result = schema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.expectedUpdatedAt).toEqual(new Date(revision))
  })
})
