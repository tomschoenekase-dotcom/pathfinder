import { describe, expect, it } from 'vitest'

import { buildGuestVisitorParty, renderGuestVisitorParty } from './guest-conversation-party'

// Fictional people only.
const party = (...messages: string[]) => buildGuestVisitorParty(messages)

describe('persons', () => {
  it.each([
    'My child is not 9 years old.',
    'My child is maybe 9 years old.',
    'My child is not 40 inches.',
    'My child might be 40 inches.',
  ])('does not turn a denied or uncertain measurement into a fact: %s', (message) => {
    expect(party(message).persons[0]).toMatchObject({ ageYears: null, heightInches: null })
  })

  it('retains unrefuted facts and clears directly refuted facts', () => {
    expect(
      party(
        'My child is 9 years old and 40 inches.',
        'My child is not 10 years old and not 48 inches.',
      ).persons[0],
    ).toMatchObject({ ageYears: 9, heightInches: 40 })
    expect(
      party(
        'My child is 9 years old and 40 inches.',
        'My child is not 9 years old and not 40 inches.',
      ).persons[0],
    ).toMatchObject({ ageYears: null, heightInches: null })
    expect(
      party('Maya is 9 years old.', 'Maya is not 9 years old.').persons[0]?.ageYears,
    ).toBeNull()
  })

  it('keeps affirmative measurements in separate clauses', () => {
    expect(party('My child is not 10 years old and is 40 inches.').persons[0]).toMatchObject({
      ageYears: null,
      heightInches: 40,
    })
    expect(party('My child is 9 years old and is not 48 inches.').persons[0]).toMatchObject({
      ageYears: 9,
      heightInches: null,
    })
  })

  it('extracts self bare age only with existing age context and safe units', () => {
    expect(
      party('I am 18. My child is 8 years old.').persons.find((person) => person.self)?.ageYears,
    ).toBe(18)
    expect(party('I am 18.').persons).toEqual([])
    expect(
      party('I am 18 tokens. My child is 8 years old.').persons.some((person) => person.self),
    ).toBe(false)
  })

  it.each(['on-ice', 'in-room', 'designated adult'])(
    'binds an explicit modified companion without participant fallback: %s',
    (modifier) => {
      const result = party(`I am 18 years old. Can I be their ${modifier} companion?`)
      expect(result.roles).toEqual([{ personId: 'P1', role: 'companion' }])
      expect(party(`Can I be their ${modifier} companion?`).roles).toEqual([])
    },
  )

  it('leaves an unfamiliar companion modifier unresolved rather than assigning participant', () => {
    expect(party('I am 18 years old. Can I be their specially trained companion?').roles).toEqual(
      [],
    )
  })

  it('keeps paired age and height attached to each named person', () => {
    const p = party(
      'Mika is 19 and 37 inches. Jules is 12 and 50 inches. Could they do it together?',
    )
    expect(
      p.persons.map(({ label, ageYears, heightInches }) => ({ label, ageYears, heightInches })),
    ).toEqual([
      { label: 'Mika', ageYears: 19, heightInches: 37 },
      { label: 'Jules', ageYears: 12, heightInches: 50 },
    ])
    expect(p.roles.every((role) => role.role !== 'companion' && role.role !== 'rider')).toBe(true)
  })

  it('does not convert a price, an alternative or a height into a paired age', () => {
    for (const message of [
      'Maya is 19 dollars and 46 inches',
      'Maya is 39 or 46 inches',
      'Maya is 39 inches and 46 years old',
    ]) {
      const p = party(message)
      expect(p.persons[0]?.ageYears).toBe(message.includes('years old') ? 46 : null)
    }
  })

  it('does not truncate a decimal height at a sentence boundary', () => {
    expect(
      party('Maya is 46.5 inches. My son is 44 inches.').persons.map((p) => p.heightInches),
    ).toEqual([46.5, 44])
  })

  it('reads two people with heights in one message', () => {
    const p = party('My son is 40 inches and my daughter is 48 inches. What can they ride?')
    expect(p.persons).toHaveLength(2)
    expect(p.persons[0]).toMatchObject({
      id: 'P1',
      label: 'my son',
      gender: 'male',
      heightInches: 40,
      self: false,
    })
    expect(p.persons[1]).toMatchObject({
      id: 'P2',
      label: 'my daughter',
      gender: 'female',
      heightInches: 48,
    })
  })

  it('gives a unit-less second height the same unit when the message states inches', () => {
    const p = party('my son is 40 inches and my daughter is 48')
    expect(p.persons.map((x) => x.heightInches)).toEqual([40, 48])
    expect(p.persons[1]!.heightText).toBe('48 in')
  })

  it('does not read a unit-less number as a height when no inches appear in the message', () => {
    // A relation mention still creates the person (my son), but with no height.
    const p = party('my son is 40')
    expect(p.persons).toHaveLength(1)
    expect(p.persons[0]).toMatchObject({ label: 'my son', heightInches: null, ageYears: null })
  })

  it('reads ages from "my 7-year-old" forms', () => {
    const p = party('My 7-year-old is nervous about coasters.')
    expect(p.persons).toHaveLength(1)
    expect(p.persons[0]).toMatchObject({
      label: 'the 7-year-old',
      ageYears: 7,
      heightInches: null,
      ageMessage: 1,
    })
    const q = party('My 9-year-old daughter loves it')
    expect(q.persons[0]).toMatchObject({ label: 'my daughter', ageYears: 9, gender: 'female' })
  })

  it('reads the visitor as self from "I\'m 5\'4\\""', () => {
    const p = party("I'm 5'4\" and my son is 44 in.")
    const self = p.persons.find((x) => x.self)!
    expect(self).toMatchObject({ label: 'the visitor', heightInches: 64, gender: null })
    expect(p.persons).toHaveLength(2)
  })

  it('does not make the visitor a person without a measurement', () => {
    expect(party("I'm excited for the day").persons).toEqual([])
    expect(party('Maya is excited').persons).toEqual([])
    // Questionable: "my friend" is a relation mention, so it becomes a person with no facts; the
    // name "Maya" does not.
    expect(party('Maya is my friend').persons.map((x) => x.label)).toEqual(['my friend'])
  })

  it('reads a named person only with a measurement', () => {
    const p = party('Maya is 46 inches tall')
    expect(p.persons).toHaveLength(1)
    expect(p.persons[0]).toMatchObject({ label: 'Maya', heightInches: 46 })
  })

  it('ignores capitalized sentence starters that are not names', () => {
    expect(party('The ride is 44 inches').persons).toEqual([])
  })

  it('converts cm heights', () => {
    const p = party('My son is 122 cm')
    expect(p.persons[0]!.heightInches).toBe(48)
    expect(p.persons[0]!.heightText).toBe('122 cm')
  })

  it('lets a later message update a height and records which message said it', () => {
    const p = party('My son is 40 inches.', 'Actually my son is 42 inches now. Can he ride?')
    expect(p.persons).toHaveLength(1)
    expect(p.persons[0]).toMatchObject({ heightInches: 42, heightMessage: 2 })
  })

  it('keeps an earlier attribute when a later message states another', () => {
    const p = party('My son is 40 inches.', 'My son is 8 years old. Can he ride?')
    expect(p.persons[0]).toMatchObject({
      heightInches: 40,
      heightMessage: 1,
      ageYears: 8,
      ageMessage: 2,
    })
  })

  it('"I have two kids, 41 and 47 inches" makes two children and not the visitor', () => {
    const p = party('I have two kids, 41 and 47 inches')
    expect(p.persons.some((x) => x.self)).toBe(false)
    expect(p.persons).toHaveLength(2)
    expect(p.persons.map((x) => x.heightInches)).toEqual([41, 47])
    expect(p.persons.map((x) => x.label)).toEqual(['the 41-inch child', 'the 47-inch child'])
  })

  it('reads "my kids who are 40 and 48 inches"', () => {
    const p = party('We have two kids who are 40 and 48 inches')
    expect(p.persons.map((x) => x.heightInches)).toEqual([40, 48])
  })
})

describe('role binding', () => {
  const family = 'My son is 40 inches and my daughter is 48 inches. '

  // "Ride with" is symmetric (2026-11-01 paid run: grammatical binding swapped the roles).
  it('marks "can A ride with B" as riding together without assigning rider and companion', () => {
    const p = party(`${family}Can he ride it with her?`)
    expect(p.roles).toEqual([
      { personId: 'P1', role: 'together' },
      { personId: 'P2', role: 'together' },
    ])
    expect(p.unresolvedReference).toBeNull()
  })

  it('binds a "take/accompany" pattern with the subject as companion', () => {
    const p = party(`${family}Can she take him on the coaster?`)
    expect(p.roles).toEqual([
      { personId: 'P2', role: 'companion' },
      { personId: 'P1', role: 'rider' },
    ])
    const q = party(`${family}Can my daughter accompany my son?`)
    expect(q.roles).toEqual([
      { personId: 'P2', role: 'companion' },
      { personId: 'P1', role: 'rider' },
    ])
  })

  it('binds "as a companion"', () => {
    const p = party(`${family}Can my daughter go as a companion?`)
    expect(p.roles).toEqual([{ personId: 'P2', role: 'companion' }])
  })

  it('binds "ride alone"', () => {
    const p = party(`${family}Can he ride alone?`)
    expect(p.roles).toEqual([{ personId: 'P1', role: 'alone' }])
    const q = party(`${family}Can my daughter ride it by herself?`)
    expect(q.roles).toEqual([{ personId: 'P2', role: 'alone' }])
  })

  it('binds a bare pronoun subject as participant', () => {
    const p = party(`${family}Can he ride it?`)
    expect(p.roles).toEqual([{ personId: 'P1', role: 'participant' }])
  })

  it('reports an ambiguous pronoun with two same-gender people', () => {
    const p = party('My son is 40 inches and my nephew is 48 inches. Can he ride alone?')
    expect(p.roles).toEqual([])
    expect(p.unresolvedReference).toBe('he')
  })

  it('falls back to the sole person when gender was never stated', () => {
    const p = party('My 7-year-old is 44 inches. Can she ride it?')
    expect(p.roles).toEqual([{ personId: 'P1', role: 'participant' }])
    expect(p.unresolvedReference).toBeNull()
  })

  it('does not use the sole-person fallback when the person is known to be the other gender', () => {
    const p = party('My son is 44 inches. Can she ride it?')
    expect(p.roles).toEqual([])
    expect(p.unresolvedReference).toBe('she')
  })

  it('resolves "the older one" and "the younger one" by age, then height', () => {
    const ages = party('My 10-year-old and my 6-year-old are coming. Can the older one ride alone?')
    expect(ages.persons.map((x) => x.ageYears)).toEqual([10, 6])
    expect(ages.roles).toEqual([{ personId: 'P1', role: 'alone' }])
    const heights = party(
      'My son is 40 inches and my daughter is 48 inches. Can the younger one ride alone?',
    )
    expect(heights.roles).toEqual([{ personId: 'P1', role: 'alone' }])
  })

  it('leaves "the older one" unresolved with fewer than two measured people', () => {
    const p = party('My son is 40 inches. Can the older one ride alone?')
    expect(p.roles).toEqual([])
    expect(p.unresolvedReference).toBe('the older one')
  })

  it('binds roles only from the last message', () => {
    const p = party(
      'My son is 40 inches and my daughter is 48 inches. Can he ride with her?',
      'What time does it close?',
    )
    expect(p.roles).toEqual([])
    expect(p.persons).toHaveLength(2)
  })

  it('does not set unresolvedReference for non-person words', () => {
    const p = party('My son is 40 inches. Can he ride with the stroller?')
    expect(p.unresolvedReference).toBeNull()
  })

  it('does not set unresolvedReference when nobody is described and the word is not a reference', () => {
    const p = party('Can I bring the stroller?')
    expect(p.persons).toEqual([])
    expect(p.unresolvedReference).toBeNull()
  })

  it('resolves the visitor as one of the people riding together', () => {
    const p = party("I'm 5'4\" and my son is 44 in. Can I ride it with him?")
    expect(p.roles).toEqual([
      { personId: 'P1', role: 'together' },
      { personId: 'P2', role: 'together' },
    ])
  })

  it('returns an empty party for no messages', () => {
    expect(buildGuestVisitorParty([])).toEqual({
      persons: [],
      roles: [],
      unresolvedReference: null,
    })
  })
})

describe('renderGuestVisitorParty', () => {
  it('is empty when no person was described', () => {
    expect(renderGuestVisitorParty(party('What time do you open?'))).toEqual([])
  })

  it('renders person lines, roles and no unresolved line', () => {
    const lines = renderGuestVisitorParty(
      party('My son is 40 inches and my daughter is 8 years old. Can he ride it with her?'),
    )
    expect(lines).toEqual([
      'P1 "my son": height 40 inches (visitor message 1); age unavailable in this projection',
      'P2 "my daughter": height unavailable in this projection; age 8 (visitor message 1)',
      "Riding or going together: P1 (my son) and P2 (my daughter). The wording does not say who is the rider and who is the companion: decide from each person's own height and age against the rule, and say which person each requirement applies to.",
    ])
  })

  it('renders unresolved projection wording when no roles were bound', () => {
    const lines = renderGuestVisitorParty(party('My son is 40 inches.'))
    expect(lines.at(-1)).toBe("This question's roles: unresolved in this projection.")
  })

  it('shows the converted inches for cm heights', () => {
    const lines = renderGuestVisitorParty(party('My son is 122 cm'))
    expect(lines[0]).toBe(
      'P1 "my son": height 122 cm (about 48 in) (visitor message 1); age unavailable in this projection',
    )
  })

  it('renders an unresolved reference line', () => {
    const lines = renderGuestVisitorParty(
      party('My son is 40 inches and my nephew is 48 inches. Can he ride alone?'),
    )
    expect(lines.at(-1)).toBe(
      'Unresolved reference: "he" could mean more than one person, or no described person.',
    )
    expect(lines.at(-2)).toBe("This question's roles: unresolved in this projection.")
  })
})
