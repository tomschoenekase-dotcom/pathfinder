import { describe, expect, it } from 'vitest'
import { guestEntryPriceBreakdown } from './guest-price-breakdown'

const tariffs =
  'Grounds ticket: Adults ages 18 and older $14; ages 5 through 17 $7; under 5 free.\nHouse supplement: $9 per person ages 5 and older; under 5 free with an adult.'
describe('per-component party arithmetic', () => {
  it('calculates component subtotals independently before a combined purchase', () => {
    const rows = guestEntryPriceBreakdown(
      'What is total entry for two adults and a child aged 9 including the house supplement?',
      tariffs,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('2 adults x $14.00 + 1 child age 9 x $7.00 = $35.00')
    expect(rows[1]).toContain('2 adults x $9.00 + 1 child age 9 x $9.00 = $27.00')
  })
  it('keeps age boundaries and free child rates attached to each component', () => {
    const child4 = guestEntryPriceBreakdown(
      'Total entry for one adult and a child aged 4?',
      tariffs,
    )
    expect(child4[0]).toContain('= $14.00')
    expect(child4[1]).toContain('= $9.00')
    const child5 = guestEntryPriceBreakdown(
      'Total entry for one adult and a child aged 5?',
      tariffs,
    )
    expect(child5[0]).toContain('= $21.00')
    expect(child5[1]).toContain('= $18.00')
  })
  it.each([
    'Total for two adults and two children aged 9?',
    'Total for two adults and a child aged 9 and a baby?',
    'Total for two adults and a child aged 9 plus Maya?',
    'Total for two adults and a child?',
    'Total for zero adults and a child aged 9?',
  ])('refuses incomplete or unsupported party counts: %s', (question) => {
    expect(guestEntryPriceBreakdown(question, tariffs)).toEqual([])
  })
  it('refuses overlapping rates and never assumes everyone buys an activity place', () => {
    expect(
      guestEntryPriceBreakdown(
        'Total entry for two adults and a child aged 9?',
        tariffs.replace('under 5', 'under 10'),
      )[0],
    ).not.toContain('Grounds ticket')
    expect(
      guestEntryPriceBreakdown(
        'Total entry for two adults and a child aged 9?',
        'Price: $20 per maker.',
      ),
    ).toEqual([])
  })
  it('refuses a conditional tariff instead of stripping its time or membership qualifier', () => {
    const question = 'Total entry for two adults and a child aged 9?'
    expect(
      guestEntryPriceBreakdown(
        question,
        'Grounds ticket: Adults ages 18 and older $14 after 4pm; ages 5 through 17 $7.',
      ),
    ).toEqual([])
    expect(
      guestEntryPriceBreakdown(
        'Total entry for two adults and a child aged 9 with a member discount?',
        tariffs,
      ),
    ).toEqual([])
  })
  it.each([
    'Grounds ticket: Adults $14; ages 5 through 17 $7; all tickets cost $5 after 4pm.',
    'Grounds ticket: Adults $14; ages 5 through 17 $7; add $5 per booking.',
    'Grounds ticket: Adults $14; ages 5 through 17 $7; unidentified rule.',
    `${tariffs}\nCondition: Prices double on weekends.`,
    `${tariffs}\nPrices double on weekends.`,
    `${tariffs}\nBooking charge: Add $5 per booking.`,
    `${tariffs}\nInclusions: Grounds admission doubles on weekends.`,
  ])(
    'refuses the whole incomplete tariff record instead of dropping a qualifier: %s',
    (content) => {
      expect(
        guestEntryPriceBreakdown('Total entry for two adults and a child aged 9?', content),
      ).toEqual([])
    },
  )
  it('keeps complete nonmatching age bands and recognized metadata without changing component arithmetic', () => {
    const record = `Kind: ITEM\n${tariffs}\nInclusions: Grounds includes Orchard and Courtyard; cellar and workshop extra.\nTax: Included.\nUnknown: Student discount.`
    const rows = guestEntryPriceBreakdown('Total entry for two adults and a child aged 9?', record)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('= $35.00')
    expect(rows[1]).toContain('= $27.00')
  })
})
