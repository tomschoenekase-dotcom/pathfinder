import { describe, expect, it } from 'vitest'

import { RetireKnowledgeEntryInput, UpdateKnowledgeEntryInput } from './knowledge'
import { RetirePlaceInput, UpdatePlaceInput } from './place'

const id = 'cm00000000000000000000001'
const venueId = 'cm00000000000000000000002'
const expectedUpdatedAt = '2026-08-11T14:30:00.000Z'

describe('legacy content CAS schemas', () => {
  it.each([
    UpdatePlaceInput,
    RetirePlaceInput,
    UpdateKnowledgeEntryInput,
    RetireKnowledgeEntryInput,
  ])('rejects a mutation without venue and version authority', (schema) => {
    expect(schema.safeParse({ id }).success).toBe(false)
  })

  it.each([
    UpdatePlaceInput,
    RetirePlaceInput,
    UpdateKnowledgeEntryInput,
    RetireKnowledgeEntryInput,
  ])('coerces the required expectedUpdatedAt boundary to a Date', (schema) => {
    const result = schema.safeParse({ id, venueId, expectedUpdatedAt })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.expectedUpdatedAt).toEqual(new Date(expectedUpdatedAt))
  })
})
