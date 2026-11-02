import { describe, expect, it } from 'vitest'
import { buildGuestVisitorParty, renderGuestVisitorParty } from './guest-conversation-party'

describe('visitor measurement ownership', () => {
  it.each([
    [
      'My son is 9 years old and 46 inches. I am 31 years old and 41 inches.',
      'Could my 16-year-old sister replace me as the adult?',
    ],
    [
      'Mon fils a 9 ans et mesure 46 pouces. Je fais 41 pouces et ai 31 ans.',
      'Et si ma sœur de 16 ans me remplace comme adulte ?',
    ],
  ])('keeps a replacement relative separate from the parent and child: %s', (first, current) => {
    const party = buildGuestVisitorParty([first, current])
    expect(party.persons.find((person) => person.self)).toMatchObject({
      ageYears: 31,
      heightInches: 41,
    })
    expect(party.persons.find((person) => person.label === 'my son')).toMatchObject({
      ageYears: 9,
      heightInches: 46,
    })
    expect(party.persons.find((person) => person.label === 'my sister')).toMatchObject({
      ageYears: 16,
      heightInches: null,
      heightMessage: null,
    })
    expect(renderGuestVisitorParty(party).find((line) => line.includes('my sister'))).toContain(
      "do not use another person's height",
    )
  })
  it('updates only an unambiguous pronoun owner and never transfers a sibling measurement', () => {
    const party = buildGuestVisitorParty([
      'My son is 9 years old and 46 inches.',
      'His sister is 16 years old.',
      'She is 51 inches.',
    ])
    expect(party.persons.find((person) => person.label === 'my son')).toMatchObject({
      heightInches: 46,
      ageYears: 9,
    })
    expect(party.persons.find((person) => person.label === 'his sister')).toMatchObject({
      heightInches: 51,
      ageYears: 16,
      heightMessage: 3,
    })
  })
  it('does not choose a measurement owner when two people fit a pronoun', () => {
    const party = buildGuestVisitorParty([
      'My daughter is 8 years old. My sister is 16 years old.',
      'She is 51 inches.',
    ])
    expect(party.persons).toHaveLength(2)
    expect(party.persons.every((person) => person.heightInches === null)).toBe(true)
  })
  it('does not fill missing ages or heights for a newly introduced family member', () => {
    const party = buildGuestVisitorParty([
      'I am 31 years old and 41 inches.',
      'My brother will come instead.',
    ])
    expect(party.persons.find((person) => person.label === 'my brother')).toMatchObject({
      ageYears: null,
      heightInches: null,
    })
  })
  it('does not turn French denied measurements into affirmative person facts', () => {
    const party = buildGuestVisitorParty([
      'Ma sœur a 16 ans et mesure 51 pouces.',
      'Ma sœur ne mesure pas 51 pouces et n’a pas 16 ans.',
    ])
    expect(party.persons[0]).toMatchObject({ ageYears: null, heightInches: null })
  })
  it.each([
    'What if he is 52 inches?',
    'If he is 52 inches, could he ride alone?',
    'Suppose my son is 52 inches.',
    'He is 52 inches if his shoes count.',
    'What if he is not 46 inches?',
    'Et si mon fils mesure 52 pouces ?',
  ])(
    'does not replace or clear factual owner measurements from a hypothetical: %s',
    (hypothetical) => {
      const party = buildGuestVisitorParty([
        'My son is 9 years old and 46 inches.',
        hypothetical,
        'Can he ride alone?',
      ])
      expect(party.persons.find((person) => person.label === 'my son')).toMatchObject({
        ageYears: 9,
        ageMessage: 1,
        heightInches: 46,
        heightMessage: 1,
      })
    },
  )
  it('keeps an asserted age descriptor when a conditional question proposes a different role', () => {
    const party = buildGuestVisitorParty([
      'If my 16-year-old sister comes, could she replace me as the adult?',
    ])
    expect(party.persons[0]).toMatchObject({ ageYears: 16, heightInches: null })
  })
  it('still accepts an unambiguous factual correction after a hypothetical question', () => {
    const party = buildGuestVisitorParty([
      'My son is 9 years old and 46 inches.',
      'What if he is 52 inches?',
      'He is actually 48 inches.',
    ])
    expect(party.persons[0]).toMatchObject({ heightInches: 48, heightMessage: 3, ageYears: 9 })
  })
})
