import { describe, expect, it } from 'vitest'

import { GUEST_VISIT_CONTEXT_LIMITS, GuestVisitContextInput } from './guest-visit-context'

describe('GuestVisitContextInput', () => {
  it('defaults to an empty bounded context', () => {
    expect(GuestVisitContextInput.parse({})).toEqual({
      visitedPlaceIds: [],
      interests: [],
    })
  })

  it('accepts and trims explicit visitor-provided recommendation context', () => {
    expect(
      GuestVisitContextInput.parse({
        visitedPlaceIds: ['place-1', 'floor_2:case.12'],
        interests: [' trains ', 'St. Louis history'],
        remainingMinutes: 15,
      }),
    ).toEqual({
      visitedPlaceIds: ['place-1', 'floor_2:case.12'],
      interests: ['trains', 'St. Louis history'],
      remainingMinutes: 15,
    })

    expect(GuestVisitContextInput.parse({ remainingMinutes: null })).toEqual({
      visitedPlaceIds: [],
      interests: [],
      remainingMinutes: null,
    })
  })

  it('rejects duplicate visited place IDs instead of silently changing visitor input', () => {
    expect(() =>
      GuestVisitContextInput.parse({ visitedPlaceIds: ['place-1', ' place-1 '] }),
    ).toThrow(/unique/u)
  })

  it('rejects values outside the documented bounds', () => {
    expect(() =>
      GuestVisitContextInput.parse({
        visitedPlaceIds: Array.from(
          { length: GUEST_VISIT_CONTEXT_LIMITS.visitedPlaceIds + 1 },
          (_, index) => `place-${index}`,
        ),
      }),
    ).toThrow()
    expect(() =>
      GuestVisitContextInput.parse({
        interests: Array.from(
          { length: GUEST_VISIT_CONTEXT_LIMITS.interests + 1 },
          (_, index) => `interest-${index}`,
        ),
      }),
    ).toThrow()
    expect(() => GuestVisitContextInput.parse({ remainingMinutes: 0 })).toThrow()
    expect(() =>
      GuestVisitContextInput.parse({
        remainingMinutes: GUEST_VISIT_CONTEXT_LIMITS.remainingMinutes + 1,
      }),
    ).toThrow()
  })

  it.each([
    ['transcript', { transcript: ['full chat history'] }],
    ['identity', { visitorId: 'visitor-private-id' }],
    ['authentication', { authenticatedActorRef: 'employee-private-id' }],
    ['coordinates', { latitude: 38.627, longitude: -90.199 }],
    ['inferred facts', { knownFacts: ['Visitor likes every train exhibit'] }],
    ['freeform history', { history: 'The visitor discussed the entire second floor.' }],
  ])('strictly rejects unknown %s fields', (_label, unknownFields) => {
    expect(() => GuestVisitContextInput.parse({ ...unknownFields })).toThrow(/unrecognized key/iu)
  })
})
