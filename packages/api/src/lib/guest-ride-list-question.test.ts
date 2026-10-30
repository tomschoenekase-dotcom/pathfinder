import { describe, expect, it } from 'vitest'

import { isGuestRideListEligibilityQuestion } from './venue-context'

describe('ride-list eligibility questions', () => {
  it.each([
    'My son is 42 inches tall. Which rides could he do next season?',
    'My child is 4. Which rides can they go on?',
    'what can my 6 year old ride here',
    'Which water slides can a 48" kid use?',
    'list all the rides my toddler can go on',
  ])('detects %s', (message) => expect(isGuestRideListEligibilityQuestion(message)).toBe(true))

  it.each([
    'Can my 6 year old ride Tide Swing with me?',
    'Which rides are closed this weekend?',
    'How tall is the drop on the big coaster?',
    'What time does the park close?',
  ])('leaves %s alone', (message) =>
    expect(isGuestRideListEligibilityQuestion(message)).toBe(false),
  )
})
