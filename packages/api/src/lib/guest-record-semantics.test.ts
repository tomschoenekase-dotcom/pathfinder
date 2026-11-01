import { describe, expect, it } from 'vitest'

import {
  guestThingNames,
  guestThingPredicate,
  lintGuestRecordSemantics,
  parseGuestRecordSemantics,
} from './guest-record-semantics'

// Fictional venue records only.
const parse = (content: string, extra: { title?: string; category?: string | null; placeType?: string | null; itemType?: string | null } = {}) =>
  parseGuestRecordSemantics({ title: extra.title ?? 'Test record', content, ...extra })

describe('labeled-line parsing', () => {
  it('turns ordinary labeled lines into facts with normalized attributes', () => {
    const s = parse('Height: 44 in minimum\nPrice: $12\nHours: 9 am to 5 pm\nLocation: Pier gate')
    expect(s.facts.map((f) => [f.label, f.attribute])).toEqual([
      ['Height', 'height'],
      ['Price', 'price'],
      ['Hours', 'hours'],
      ['Location', 'location'],
    ])
    expect(s.facts[0]!.value).toBe('44 in minimum')
  })

  it('keeps unknown labels as their own normalized key', () => {
    const s = parse('Weekday price: $9')
    expect(s.facts[0]!.attribute).toBe('price')
    const t = parse('Mascot name: Pip')
    expect(t.facts[0]!.attribute).toBe('mascot name')
  })

  it('reads every structural label into its field', () => {
    const s = parse(
      [
        'Kind: wooden roller coaster',
        'Also called: The Tide Swing, Pier Swing',
        'Applies to: Lagoon Looper; Tide Swing',
        'Does not apply to: Picnic Pods',
        'Governed by: Ride Rules',
        'See also: Day Admission',
        'Condition: Must be ticketed',
        'Exception: Staff may waive',
        'Consequence: The pass is forfeited.',
        'Must mention: Leaving the park ends your pass.',
        'Unknown: companion height',
        'Effective: June 1 to Aug 31',
      ].join('\n'),
    )
    expect(s.kind).toBe('PLACE')
    expect(s.kindSource).toBe('stated')
    expect(s.type).toBe('wooden roller coaster')
    expect(s.aliases).toEqual(['The Tide Swing', 'Pier Swing'])
    expect(s.scope.appliesTo).toEqual(['Lagoon Looper', 'Tide Swing'])
    expect(s.scope.doesNotApplyTo).toEqual(['Picnic Pods'])
    expect(s.links).toEqual([
      { relation: 'governed-by', target: 'Ride Rules' },
      { relation: 'see-also', target: 'Day Admission' },
    ])
    expect(s.conditions).toEqual(['Must be ticketed'])
    expect(s.exceptions).toEqual(['Staff may waive'])
    expect(s.consequences).toEqual(['The pass is forfeited.'])
    expect(s.mustMention).toEqual(['Leaving the park ends your pass.'])
    expect(s.unknowns).toEqual(['companion height'])
    expect(s.effective).toBe('June 1 to Aug 31')
    expect(s.facts).toEqual([])
  })

  it('matches structural labels case-insensitively and accepts alternate spellings', () => {
    const s = parse('ALSO KNOWN AS: Pip Ride\nRequires: a wristband\nREQUIRED NOTICE: Wear shoes.')
    expect(s.aliases).toEqual(['Pip Ride'])
    expect(s.conditions).toEqual(['a wristband'])
    expect(s.mustMention).toEqual(['Wear shoes.'])
  })

  it('splits list labels on semicolons, capitalized commas and "and Capital"', () => {
    const s = parse('Applies to: Tide Swing, Lagoon Looper and Pier Slide; Mini Carousel')
    expect(s.scope.appliesTo).toEqual(['Tide Swing', 'Lagoon Looper', 'Pier Slide', 'Mini Carousel'])
  })

  it('does not split a lowercase comma list in a list field', () => {
    const s = parse('Applies to: all coasters, slides and swings')
    expect(s.scope.appliesTo).toEqual(['all coasters, slides and swings'])
  })

  it('dedupes aliases', () => {
    const s = parse('Also called: Pip Ride\nAka: Pip Ride')
    expect(s.aliases).toEqual(['Pip Ride'])
  })

  it('keeps "Rules: no glass" and "Not for: under 3s" as ordinary facts', () => {
    const s = parse('Rules: no glass\nNot for: under 3s\nCovers: the lawn')
    expect(s.facts.map((f) => f.label)).toEqual(['Rules', 'Not for', 'Covers'])
    expect(s.conditions).toEqual([])
    expect(s.scope.doesNotApplyTo).toEqual([])
    expect(s.facts[0]!.clauses[0]!.negative).toBe(true)
  })

  it('treats prose lines that contain a colon as prose, not labels', () => {
    const s = parse('The coaster is fast: very\nThere are three of them: all open')
    expect(s.facts).toEqual([])
  })

  it('does not treat times as labels', () => {
    const s = parse('Open 10:30 am daily')
    expect(s.facts).toEqual([])
    const t = parse('Open 10: 30 am daily')
    expect(t.facts).toEqual([])
  })

  it('treats labels with more than four words as prose', () => {
    const s = parse('This is a very long label: value')
    expect(s.facts).toEqual([])
    const t = parse('One two three four five: value')
    expect(t.facts).toEqual([])
  })

  it('skips blank lines and handles CRLF', () => {
    const s = parse('Height: 40 in\r\n\r\nPrice: $5\r\n')
    expect(s.facts.map((f) => f.value)).toEqual(['40 in', '$5'])
  })
})

describe('clause parsing', () => {
  it('splits on semicolons and binds roles with quantities', () => {
    const s = parse('Height: 40 in with a qualifying companion; 48 in alone')
    const [first, second] = s.facts[0]!.clauses
    expect(first).toMatchObject({ role: 'accompanied', quantity: { value: 40, unit: 'in', inches: 40 } })
    expect(second).toMatchObject({ role: 'alone', quantity: { value: 48, unit: 'in', inches: 48 } })
  })

  it('does not give a quantity to a clause with two numbers', () => {
    const s = parse('Companion: under 12 must stay with an adult 18 or older')
    const clause = s.facts[0]!.clauses[0]!
    expect(clause.quantity).toBeNull()
  })

  it('reads a companion clause role', () => {
    const s = parse('Companion: a companion must be at least 14')
    expect(s.facts[0]!.clauses[0]!.role).toBe('companion')
  })

  it('reads cm heights and converts to inches', () => {
    const s = parse('Height: 122 cm minimum')
    expect(s.facts[0]!.clauses[0]!.quantity).toEqual({ value: 122, unit: 'cm', inches: 48, bound: 'min' })
  })

  it('reads feet-and-inches heights', () => {
    const s = parse("Height: 4 ft 2 in minimum")
    const q = s.facts[0]!.clauses[0]!.quantity
    // two numbers (4 and 2) in the clause means no quantity at all
    expect(q).toBeNull()
  })

  it('reads a feet-only height', () => {
    const s = parse('Height: 4 feet tall minimum')
    expect(s.facts[0]!.clauses[0]!.quantity).toMatchObject({ unit: 'in', inches: 48, bound: 'min' })
  })

  it('reads an age under an Age label with a bare number', () => {
    const s = parse('Age: at least 14')
    expect(s.facts[0]!.clauses[0]!.quantity).toEqual({ value: 14, unit: 'years', bound: 'min' })
  })

  it('does not read a bare number as an age under a non-age label', () => {
    const s = parse('Notes: at least 14')
    expect(s.facts[0]!.clauses[0]!.quantity).toBeNull()
  })

  it('reads explicit ages, prices and minutes', () => {
    const s = parse('Ticket: ages 3 and under are free\nCost: $12.50\nWait: 20 minutes')
    expect(s.facts[0]!.clauses[0]!.quantity).toMatchObject({ unit: 'years', value: 3 })
    expect(s.facts[1]!.clauses[0]!.quantity).toEqual({ value: 12.5, unit: 'usd', bound: null })
    expect(s.facts[2]!.clauses[0]!.quantity).toMatchObject({ value: 20, unit: 'minutes' })
  })

  // Regression: "minutes" once matched the "min" bound word.
  it('does not mark a plain duration as a minimum bound', () => {
    const s = parse('Wait: 20 minutes')
    expect(s.facts[0]!.clauses[0]!.quantity!.bound).toBeNull()
  })

  it('reads max bounds', () => {
    const s = parse('Height: under 54 in')
    expect(s.facts[0]!.clauses[0]!.quantity).toMatchObject({ value: 54, bound: 'max' })
  })

  it('does not invent a child role from an age bound and preserves explicit companion roles', () => {
    expect(parse('Age: under 12').facts[0]!.clauses[0]!.role).toBeNull()
    expect(parse('Companion: companion under 14 years old').facts[0]!.clauses[0]!.role).toBe('companion')
  })

  it('flags negative and unknown clauses', () => {
    const s = parse('Rules: no glass; shoes required\nHours: not posted; ask staff\nPets: not allowed')
    const [glass, shoes] = s.facts[0]!.clauses
    expect(glass!.negative).toBe(true)
    expect(shoes!.negative).toBe(false)
    const [notPosted, ask] = s.facts[1]!.clauses
    expect(notPosted!.unknown).toBe(true)
    expect(ask!.unknown).toBe(true)
    expect(s.facts[2]!.clauses[0]!.negative).toBe(true)
  })

  it('assigns other roles', () => {
    const s = parse('Price: seniors 65 and older $5; members free; groups of 10 or more $8; children under 5 free')
    const roles = s.facts[0]!.clauses.map((c) => c.role)
    expect(roles).toEqual(['senior', 'member', 'group', 'child'])
  })
})

describe('kind inference', () => {
  it('uses place type for places and marks the source "place"', () => {
    const s = parse('Tide Swing is a swinging ride near the pier gate.', { placeType: 'attraction' })
    expect(s.kind).toBe('PLACE')
    expect(s.kindSource).toBe('place')
    expect(s.type).toBe('swinging ride near the pier gate'.split(' near')[0])
  })

  it('falls back to a meaningful item type, then place type, for a place with no predicate', () => {
    expect(parse('Open daily.', { placeType: 'attraction', itemType: 'carousel' }).type).toBe('carousel')
    expect(parse('Open daily.', { placeType: 'attraction', itemType: 'physical_place' }).type).toBe('attraction')
    expect(parse('Open daily.', { placeType: 'attraction' }).type).toBe('attraction')
  })

  it('infers kinds from the title and marks them inferred', () => {
    expect(parse('x', { title: 'Day admission' })).toMatchObject({ kind: 'ITEM', kindSource: 'inferred' })
    expect(parse('x', { title: 'Weather policy' })).toMatchObject({ kind: 'POLICY', kindSource: 'inferred' })
    expect(parse('x', { title: 'Harbor festival' })).toMatchObject({ kind: 'EVENT' })
    expect(parse('x', { title: 'Locker rentals' })).toMatchObject({ kind: 'SERVICE' })
    expect(parse('x', { title: 'Wooden coaster' })).toMatchObject({ kind: 'PLACE' })
  })

  it('uses the category when the title has no kind word, even for offers', () => {
    expect(parse('x', { title: 'Group outings', category: 'Tickets' }).kind).toBe('ITEM')
    // A title kind word wins over the category.
    expect(parse('x', { title: 'Ride rules', category: 'Tickets' }).kind).toBe('POLICY')
  })

  it('uses the category when the title has no kind word', () => {
    expect(parse('x', { title: 'Lagoon Looper', category: 'Rides' }).kind).toBe('PLACE')
  })

  it('is KNOWLEDGE with a predicate type when nothing matches', () => {
    const s = parse('Founders Day is the story behind the harbor.', { title: 'Our story' })
    expect(s.kind).toBe('KNOWLEDGE')
    expect(s.kindSource).toBe('inferred')
    // "behind" ends the noun phrase (location words are not part of what a thing is).
    expect(s.type).toBe('story')
  })

  it('is KNOWLEDGE with null type with no predicate', () => {
    const s = parse('Open daily.', { title: 'Our story' })
    expect(s).toMatchObject({ kind: 'KNOWLEDGE', type: null })
  })

  it('a stated Kind overrides inference and lowercases the type', () => {
    const s = parse('Kind: Admission Offer', { title: 'Lagoon Looper', category: 'Rides' })
    expect(s).toMatchObject({ kind: 'ITEM', kindSource: 'stated', type: 'admission offer' })
  })

  it('a stated Kind with no kind word is KNOWLEDGE', () => {
    expect(parse('Kind: mystery').kind).toBe('KNOWLEDGE')
  })

  it('uses the first matched word (by position) as type when no predicate exists', () => {
    // Questionable: "Weather policy" yields type "weather", not "policy", because the pattern
    // alternation reports the first match in the text.
    expect(parse('Open daily.', { title: 'Weather policy' }).type).toBe('weather')
    expect(parse('Open daily.', { title: 'Group tickets' }).type).toBe('tickets')
  })
})

describe('guestThingPredicate', () => {
  it('extracts a shaded, tree-filled exhibit', () => {
    expect(guestThingPredicate('Fern Walk is a shaded, tree-filled exhibit for quiet visits.')).toBe(
      'shaded tree-filled exhibit',
    )
  })

  it('stops at a clause word', () => {
    expect(guestThingPredicate('Thunder Run is a wooden roller coaster with a steep drop.')).toBe(
      'wooden roller coaster',
    )
  })

  it('caps at six words', () => {
    expect(guestThingPredicate('Pip is a very big old red wooden spinning thing')?.split(' ')).toHaveLength(6)
  })

  it('uses only the first sentence', () => {
    expect(guestThingPredicate('Open daily. Pip is a carousel.')).toBeNull()
  })

  it('returns null with no "is a"', () => {
    expect(guestThingPredicate('Pip rides all day.')).toBeNull()
    expect(guestThingPredicate('')).toBeNull()
  })

  it('handles "are the" and "one of the"', () => {
    expect(guestThingPredicate('Picnic pods are the fenced lawn areas.')).toBe('fenced lawn areas')
    // Questionable: an article is required, so a bare plural predicate is not read.
    expect(guestThingPredicate('Picnic pods are fenced lawn areas.')).toBeNull()
    expect(guestThingPredicate('Tide Swing is one of the oldest rides here.')).toBe('oldest rides here')
  })
})

describe('material sentences', () => {
  it('detects consequence prose', () => {
    const s = parse('The rain pass is cheap. Using it gives up the rest of the day. Tickets are non-refundable.')
    expect(s.materialSentences).toEqual(['Using it gives up the rest of the day.', 'Tickets are non-refundable.'])
  })

  it('detects material wording inside a labeled fact', () => {
    const s = parse('Refunds: no refunds after purchase')
    expect(s.materialSentences).toEqual(['Refunds: no refunds after purchase'])
  })

  it('finds nothing in neutral prose', () => {
    expect(parse('A friendly carousel by the gate.').materialSentences).toEqual([])
  })

  it('caps at six and dedupes', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `Item ${i} is non-refundable.`).join(' ')
    expect(parse(lines).materialSentences).toHaveLength(6)
    expect(parse('It is non-refundable. It is non-refundable.').materialSentences).toHaveLength(1)
  })

  it('ignores sentences longer than 400 characters', () => {
    const long = `It is non-refundable ${'and very '.repeat(60)}long.`
    expect(parse(long).materialSentences).toEqual([])
  })
})

describe('guestThingNames', () => {
  it('returns title, short form before a colon or paren, and aliases', () => {
    const s = parse('Also called: Pip Ride')
    expect(guestThingNames('Tide Swing: the classic', s)).toEqual(['Tide Swing: the classic', 'Tide Swing', 'Pip Ride'])
    expect(guestThingNames('Tide Swing (pier gate)', s)).toEqual(['Tide Swing (pier gate)', 'Tide Swing', 'Pip Ride'])
    expect(guestThingNames('Tide Swing - pier', s)).toContain('Tide Swing')
  })

  it('returns just the title when there is no short form or alias', () => {
    expect(guestThingNames('Tide Swing', parse('x'))).toEqual(['Tide Swing'])
  })

  it('drops names with identity keys shorter than three characters', () => {
    const s = parse('Also called: Pi')
    expect(guestThingNames('Tide Swing', s)).toEqual(['Tide Swing'])
  })
})

describe('lintGuestRecordSemantics', () => {
  const rec = (title: string, content: string) => ({ title, semantics: parse(content, { title }) })

  it('reports contradictory exact scopes and governing links while accepting broad exceptions', () => {
    const records = [
      rec('Ember Hall', 'Kind: place\nAlso called: Ember\nGoverned by: Photo policy'),
      rec('Photo policy', 'Kind: policy\nApplies to: Ember Hall\nDoes not apply to: Ember Hall; Ember'),
    ]
    expect(lintGuestRecordSemantics(records).map((finding) => finding.code)).toEqual(expect.arrayContaining(['SCOPE_CONFLICT', 'GOVERNING_SCOPE_CONFLICT']))
    const valid = [rec('Ember Hall', 'Kind: place'), rec('Photo policy', 'Kind: policy\nApplies to: all galleries\nDoes not apply to: Ember Hall')]
    expect(lintGuestRecordSemantics(valid).some((finding) => finding.code.endsWith('SCOPE_CONFLICT'))).toBe(false)
  })

  it('reports missing link and scope targets, resolving by name and alias', () => {
    const findings = lintGuestRecordSemantics([
      rec('Ride Rules', 'Applies to: Tide Swing; Ghost Ride; all coasters\nGoverned by: Missing Policy'),
      rec('Tide Swing', 'Also called: Pip Ride'),
      rec('Day Pass', 'See also: Pip Ride'),
    ])
    expect(findings).toEqual([
      { code: 'LINK_TARGET_MISSING', record: 'Ride Rules', detail: 'Missing Policy' },
      { code: 'SCOPE_TARGET_MISSING', record: 'Ride Rules', detail: 'Ghost Ride' },
    ])
  })

  it('checks Does not apply to targets too', () => {
    const findings = lintGuestRecordSemantics([rec('Ride Rules', 'Does not apply to: Nowhere Land')])
    expect(findings.map((f) => f.code)).toEqual(['SCOPE_TARGET_MISSING'])
  })

  it('flags must-mention notices that are too long or not sentences', () => {
    const long = `${'word '.repeat(60)}ends here.`
    const findings = lintGuestRecordSemantics([
      rec('A pass', `Must mention: Wear shoes\nMust mention: ${long}`),
    ])
    expect(findings).toEqual([
      { code: 'MUST_MENTION_NOT_SENTENCE', record: 'A pass', detail: 'Wear shoes' },
      { code: 'MUST_MENTION_TOO_LONG', record: 'A pass', detail: long },
    ])
  })

  it('flags a consequence without a must-mention notice, and not when one exists', () => {
    expect(
      lintGuestRecordSemantics([rec('Rain pass', 'Consequence: you give up the day.')]).map((f) => f.code),
    ).toEqual(['CONSEQUENCE_WITHOUT_NOTICE'])
    expect(
      lintGuestRecordSemantics([
        rec('Rain pass', 'Consequence: you give up the day.\nMust mention: Using it ends your day.'),
      ]),
    ).toEqual([])
  })

  it('is empty for no records and for clean records', () => {
    expect(lintGuestRecordSemantics([])).toEqual([])
    expect(lintGuestRecordSemantics([rec('Tide Swing', 'Height: 44 in')])).toEqual([])
  })
})
