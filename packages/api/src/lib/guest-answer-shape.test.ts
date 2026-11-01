import { describe, expect, it } from 'vitest'

import { guestAnswerShape, guestAnswerShapeRule } from './guest-answer-shape'

const shapeOf = (message: string) => guestAnswerShape(message).shape

describe('shape classification', () => {
  it.each([
    "What's that big yellow coaster?",
    'What animal is that?',
    'What am I looking at?',
    'Which exhibit is this?',
    "What's that painting over there?",
  ])('IDENTIFY: %s', (message) => {
    expect(shapeOf(message)).toBe('IDENTIFY')
  })

  it.each([
    'Which rides are good for toddlers?',
    'What animals can I see here?',
    'Which galleries are open today?',
    'List all the restaurants',
    'How many coasters are there?',
    'What exhibits are free?',
  ])('LIST: %s', (message) => {
    expect(shapeOf(message)).toBe('LIST')
  })

  it.each([
    'Tell me everything about the pandas',
    'Give me the full story of the carousel',
    'I want a deep dive on the Dinosaur Hall',
    'Walk me through the history of the museum',
  ])('DEEP_DIVE: %s', (message) => {
    expect(shapeOf(message)).toBe('DEEP_DIVE')
  })

  it.each([
    'Plan our day at the zoo',
    'Can you make us a plan for 3 hours here?',
    'What order should we see the galleries in?',
    'Give me an itinerary for the park',
  ])('PLAN: %s', (message) => {
    expect(shapeOf(message)).toBe('PLAN')
  })

  it.each([
    'Tide Swing vs Lagoon Looper',
    'Compare the wooden coaster and the steel coaster',
    'What is the difference between the day pass and the rain pass?',
  ])('COMPARE: %s', (message) => {
    expect(shapeOf(message)).toBe('COMPARE')
  })

  it.each([
    'How tall do I have to be for the Lagoon Looper?',
    'What time does the aquarium close?',
    'Where are the restrooms?',
    'How much is parking?',
  ])('FACT: %s', (message) => {
    expect(shapeOf(message)).toBe('FACT')
  })

  // Questionable: comparative wording without "compare", "vs" or "difference" is not detected by
  // guestResponseIntentForMessage, so these fall through to FACT.
  it.each(['Is the Tide Swing better than the Lagoon Looper?', 'Which is better, the Tide Swing or the Lagoon Looper?'])(
    'documents that implicit comparisons are classified FACT: %s',
    (message) => {
      expect(shapeOf(message)).toBe('FACT')
    },
  )

  it('maps an EXPAND request to DEEP_DIVE regardless of wording', () => {
    expect(guestAnswerShape('What time does it close?', 'EXPAND').shape).toBe('DEEP_DIVE')
    expect(guestAnswerShape("What's that?", 'EXPAND').shape).toBe('DEEP_DIVE')
  })

  it('treats DEFAULT as no request', () => {
    expect(guestAnswerShape("What's that big yellow coaster?", 'DEFAULT').shape).toBe('IDENTIFY')
  })

  it('lets DEEP_DIVE win over IDENTIFY wording', () => {
    expect(shapeOf("Tell me everything about that yellow coaster, what's that?")).toBe('DEEP_DIVE')
  })

  it('lets LIST win over IDENTIFY when both match', () => {
    // "what are the rides" is IDENTIFY-shaped wording but names a set.
    expect(shapeOf('What are the rides here?')).toBe('LIST')
  })

  it('normalizes curly apostrophes and whitespace', () => {
    expect(shapeOf('  What’s that big yellow coaster?  ')).toBe('IDENTIFY')
  })
})

describe('flags and descriptors', () => {
  it('collects lowercase unique descriptors in order', () => {
    const r = guestAnswerShape("What's that BIG yellow coaster? The big one, yellow with spotted cars")
    expect(r.descriptors).toEqual(['big', 'yellow', 'spotted'])
  })

  it('finds multiword descriptors', () => {
    expect(guestAnswerShape("What's that upside down ride?").descriptors).toEqual(['upside down'])
  })

  it('has no descriptors when none are used', () => {
    expect(guestAnswerShape('What time does the zoo close?').descriptors).toEqual([])
  })

  it('does not match descriptor words inside other words', () => {
    expect(guestAnswerShape('Is the redwood trail open?').descriptors).toEqual([])
  })

  it.each([
    'Should we get the rain pass?',
    'Is it worth buying the combo ticket?',
    'What happens if I leave the park?',
    'Can I get a refund?',
    'Can we re-enter after lunch?',
    'How do I redeem the voucher?',
    'I want to buy the annual pass',
  ])('actionable: %s', (message) => {
    expect(guestAnswerShape(message).actionable).toBe(true)
  })

  it.each(["What's that big yellow coaster?", 'Where is the carousel?', 'Tell me about the pandas'])(
    'not actionable: %s',
    (message) => {
      expect(guestAnswerShape(message).actionable).toBe(false)
    },
  )

  it.each([
    'Can I bring a stroller into the museum?',
    'Is flash photography allowed?',
    'Can my kids feed the goats?',
    'Is it okay to bring a picnic?',
    'Are drones prohibited?',
  ])('permission: %s', (message) => {
    expect(guestAnswerShape(message).permission).toBe(true)
  })

  it('permission is not set for a plain fact question', () => {
    expect(guestAnswerShape('What time does the zoo open?').permission).toBe(false)
  })

  it('actionable and permission are independent of shape', () => {
    const r = guestAnswerShape("What's that yellow coaster, and can I bring a bag on it?")
    expect(r.shape).toBe('IDENTIFY')
    expect(r.permission).toBe(true)
    const s = guestAnswerShape('Tell me everything about the rain pass, should I get it?')
    expect(s).toMatchObject({ shape: 'DEEP_DIVE', actionable: true })
  })
})

describe('guestAnswerShapeRule', () => {
  const keep = 'keep every applicable must_mention line under NOTICE RELEVANCE, every condition or exception that changes whether the answer applies'
  const shapes = [
    "What's that big yellow coaster?",
    'Tell me everything about the pandas',
    'Which rides are fast?',
    'Plan our day',
    'Compare the wooden coaster and the steel coaster',
    'Where are the restrooms?',
  ]

  it.each(shapes)('always carries the keep sentence: %s', (message) => {
    const rule = guestAnswerShapeRule(guestAnswerShape(message))
    expect(rule).toContain(keep)
    expect(rule).toContain('relevant unknown')
    expect(rule.startsWith('ANSWER DEPTH:')).toBe(true)
  })

  it('has different guidance per shape', () => {
    const rules = new Set(shapes.map((m) => guestAnswerShapeRule(guestAnswerShape(m))))
    expect(rules.size).toBe(shapes.length)
  })

  it('IDENTIFY mentions descriptors when present, and not when absent', () => {
    const withDescriptors = guestAnswerShapeRule(guestAnswerShape("What's that big yellow coaster?"))
    expect(withDescriptors).toContain('The visitor described it as: big, yellow.')
    expect(withDescriptors).toContain('unconfirmed')
    const without = guestAnswerShapeRule(guestAnswerShape('What animal is that?'))
    expect(without).not.toContain('described it as')
  })

  it('does not mention descriptors for other shapes', () => {
    const rule = guestAnswerShapeRule(guestAnswerShape('Tell me everything about the big yellow coaster'))
    expect(rule).not.toContain('described it as')
  })

  it('FACT answers directly and LIST points at the coverage line', () => {
    expect(guestAnswerShapeRule({ shape: 'FACT', actionable: false, permission: false, descriptors: [] })).toContain(
      'Answer the asked fact first',
    )
    expect(guestAnswerShapeRule({ shape: 'LIST', actionable: false, permission: false, descriptors: [] })).toContain(
      'coverage line',
    )
  })
})
