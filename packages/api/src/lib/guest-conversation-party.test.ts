import { describe, expect, it } from 'vitest'

import { buildGuestVisitorParty, renderGuestVisitorParty } from './guest-conversation-party'

// Fictional people only.
const party = (...messages: string[]) => buildGuestVisitorParty(messages)

describe('persons', () => {
  it('reads two people with heights in one message', () => {
    const p = party('My son is 40 inches and my daughter is 48 inches. What can they ride?')
    expect(p.persons).toHaveLength(2)
    expect(p.persons[0]).toMatchObject({ id: 'P1', label: 'my son', gender: 'male', heightInches: 40, self: false })
    expect(p.persons[1]).toMatchObject({ id: 'P2', label: 'my daughter', gender: 'female', heightInches: 48 })
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
    expect(p.persons[0]).toMatchObject({ label: 'the 7-year-old', ageYears: 7, heightInches: null, ageMessage: 1 })
    const q = party('My 9-year-old daughter loves it')
    expect(q.persons[0]).toMatchObject({ label: 'my daughter', ageYears: 9, gender: 'female' })
  })

  it('reads the visitor as self from "I\'m 5\'4\\""', () => {
    const p = party('I\'m 5\'4" and my son is 44 in.')
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
    expect(p.persons[0]).toMatchObject({ heightInches: 40, heightMessage: 1, ageYears: 8, ageMessage: 2 })
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
    const heights = party('My son is 40 inches and my daughter is 48 inches. Can the younger one ride alone?')
    expect(heights.roles).toEqual([{ personId: 'P1', role: 'alone' }])
  })

  it('leaves "the older one" unresolved with fewer than two measured people', () => {
    const p = party('My son is 40 inches. Can the older one ride alone?')
    expect(p.roles).toEqual([])
    expect(p.unresolvedReference).toBe('the older one')
  })

  it('binds roles only from the last message', () => {
    const p = party('My son is 40 inches and my daughter is 48 inches. Can he ride with her?', 'What time does it close?')
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
    expect(buildGuestVisitorParty([])).toEqual({ persons: [], roles: [], unresolvedReference: null })
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
      'P1 "my son": height 40 inches (visitor message 1); age not stated',
      'P2 "my daughter": height not stated; age 8 (visitor message 1)',
      "Riding or going together: P1 (my son) and P2 (my daughter). The wording does not say who is the rider and who is the companion: decide from each person's own height and age against the rule, and say which person each requirement applies to.",
    ])
  })

  it('renders "not stated" when no roles were bound', () => {
    const lines = renderGuestVisitorParty(party('My son is 40 inches.'))
    expect(lines.at(-1)).toBe("This question's roles: not stated by the visitor.")
  })

  it('shows the converted inches for cm heights', () => {
    const lines = renderGuestVisitorParty(party('My son is 122 cm'))
    expect(lines[0]).toBe('P1 "my son": height 122 cm (about 48 in) (visitor message 1); age not stated')
  })

  it('renders an unresolved reference line', () => {
    const lines = renderGuestVisitorParty(
      party('My son is 40 inches and my nephew is 48 inches. Can he ride alone?'),
    )
    expect(lines.at(-1)).toBe('Unresolved reference: "he" could mean more than one person, or no described person.')
    expect(lines.at(-2)).toBe("This question's roles: not stated by the visitor.")
  })
})
