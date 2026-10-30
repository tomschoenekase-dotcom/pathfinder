/** Synthetic development probes; not executed during source lock. */
import { expect, it } from 'vitest'
import { parseFacetCollectionQuery } from './guest-facet-query'

it('parses explicit complete collection grammar case-insensitively', () => {
  expect(
    parseFacetCollectionQuery(
      'LIST RIDES for a 7-year-old who is 46 inches tall lasting at most 20 minutes costing at most USD 8 that are step-free and included in admission.',
    ),
  ).toEqual({
    recognized: true,
    constraints: {
      kind: 'ride',
      ageYears: 7,
      heightCm: 46 * 2.54,
      maxDurationMinutes: 20,
      maxPrice: { amount: 8, currency: 'USD' },
      access: 'step-free',
      included: true,
    },
  })
})
it.each(['Recommend rides for a 7-year-old'])(
  'keeps recommendations on their own lane: %s',
  (query) => {
    expect(parseFacetCollectionQuery(query)).toEqual({ recognized: false, constraints: {} })
  },
)
it.each([
  'Which rides for a 7-year-old or a 12-year-old?',
  'List rides for a 7-year-old unless an adult comes',
  'Which rides for a 7-year-old who is 46 incheswide tall?',
  'My children are 7 and 11, which rides?',
  'List rides costing at most about USD 8',
])('does not invent constraints for unsupported or ambiguous query prose: %s', (query) => {
  expect(parseFacetCollectionQuery(query).constraints).toEqual({})
})
it.each([
  'Which rides can my 46-inch 7-year-old do',
  'Which rides can my 46 inch 7 year old do?',
  'WHICH RIDES CAN MY 46-INCHES 7-YEAR-OLD DO?',
  'Which rides can my 46–inch 7–year–old do?',
])('supports the packet motivating example and benign forms: %s', (query) => {
  expect(parseFacetCollectionQuery(query)).toEqual({
    recognized: true,
    constraints: { kind: 'ride', ageYears: 7, heightCm: 46 * 2.54 },
  })
})
it('does not recognize malformed units as explicit child constraints', () => {
  expect(
    parseFacetCollectionQuery('Which rides can my 46-inchworms 7-year-old do?').constraints,
  ).toEqual({})
})
