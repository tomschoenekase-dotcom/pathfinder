import { describe, expect, it } from 'vitest'

import {
  classifyVisitorSignalCandidate,
  visitorHazardDeduplicationKey,
} from './visitor-signal-candidate'

describe('visitor signal candidate classification', () => {
  it.each([
    ['the gallery is closed today', 'CLOSURE_REPORT'],
    ['There is smoke near the west entrance.', 'URGENT_HAZARD'],
    ['I found broken glass on the floor.', 'URGENT_HAZARD'],
    ['The floor is slippery by the east entrance.', 'URGENT_HAZARD'],
  ] as const)('classifies explicit %s reports as %s', (reason, kind) => {
    expect(classifyVisitorSignalCandidate(reason)).toMatchObject({ kind })
  })

  it('does not page educational, hypothetical, negated, vague, or empty feedback', () => {
    expect(classifyVisitorSignalCandidate('The fire safety exhibit was great.')).toBeNull()
    expect(classifyVisitorSignalCandidate('What if there is a fire?')).toBeNull()
    expect(classifyVisitorSignalCandidate('Weapon display information was helpful.')).toBeNull()
    expect(classifyVisitorSignalCandidate('That answer was confusing.')).toBeNull()
    expect(classifyVisitorSignalCandidate('There is no smoke by the entrance.')).toBeNull()
    expect(classifyVisitorSignalCandidate('This is not a fire hazard.')).toBeNull()
    expect(classifyVisitorSignalCandidate('The route is not unsafe.')).toBeNull()
    expect(classifyVisitorSignalCandidate('The gallery is not open on Mondays.')).toMatchObject({
      kind: 'CLOSURE_REPORT',
    })
    expect(classifyVisitorSignalCandidate('   ')).toBeNull()
    expect(classifyVisitorSignalCandidate(undefined)).toBeNull()
  })

  it.each([
    'The gallery is not closed.',
    'There is no closure today.',
    "The gallery isn't closed.",
    "The route isn't unsafe.",
    'The gallery is no longer closed.',
  ])('does not turn an explicitly negated report into a candidate: %s', (reason) => {
    expect(classifyVisitorSignalCandidate(reason)).toBeNull()
  })

  it.each([
    ['The gallery is not open.', 'CLOSURE_REPORT'],
    ['The gallery is not closed, but the garden is closed.', 'CLOSURE_REPORT'],
    ['There is no smoke, but there is broken glass.', 'URGENT_HAZARD'],
  ] as const)('retains affirmative evidence in %s', (reason, kind) => {
    expect(classifyVisitorSignalCandidate(reason)).toMatchObject({ kind })
  })

  it('hashes the tenant, venue, and turn-or-message identity into a bounded event key', () => {
    const base = {
      tenantId: 'tenant',
      venueId: 'venue',
      guestChatTurnId: '11111111-1111-4111-8111-111111111111',
      messageId: 'message',
    }
    expect(visitorHazardDeduplicationKey(base)).toMatch(/^visitor-feedback-hazard:[a-f0-9]{64}$/u)
    expect(visitorHazardDeduplicationKey(base)).toBe(visitorHazardDeduplicationKey(base))
    expect(visitorHazardDeduplicationKey({ ...base, guestChatTurnId: null })).not.toBe(
      visitorHazardDeduplicationKey(base),
    )
  })
})
