import { describe, expect, it } from 'vitest'
import { parseGuestRecordSemantics } from './guest-record-semantics'
import { guestPriceTotal, guestTaxStatus } from './guest-price-scope'

const parse = (content: string) => parseGuestRecordSemantics({ title: 'Maple rentals', content })
describe('record-local tax scope', () => {
  it('does not transfer a ticket tax claim to rentals or scoped products', () => {
    expect(guestTaxStatus(parse('Tax: Listed prices include tax.'), '$5 may include tax')).toBe(
      'unstated',
    )
    expect(
      guestTaxStatus(
        parse('Tax: Listed prices include tax.'),
        'Entry $24 including tax; stroller rental $5',
      ),
    ).toBe('mixed')
    expect(guestTaxStatus(parse('Price: $5 does not include tax'), '$5 does not include tax')).toBe(
      'excluded',
    )
    expect(guestTaxStatus(parse('Price: $5 may include tax'), '$5 may include tax')).toBe(
      'unstated',
    )
    expect(guestTaxStatus(parse('Price: $5\nTax: Listed prices include tax.'), '$5')).toBe(
      'included',
    )
    expect(guestTaxStatus(parse('Price: $5'), '$5')).toBe('unstated')
    expect(guestTaxStatus(parse('Price: $5\nTax: Admission prices include tax.'), '$5')).toBe(
      'unstated',
    )
    expect(guestTaxStatus(parse('Tax: Listed prices include tax.'), '$5 plus tax')).toBe('excluded')
  })
  it('never calls mixed or unknown totals tax-inclusive', () => {
    const item = { name: 'Entry', cents: 2400, quantity: 1, tax: 'included' as const }
    expect(guestPriceTotal([item, { ...item, name: 'Rental', cents: 500 }])).toEqual({
      cents: 2900,
      qualifier: 'including tax',
    })
    for (const tax of ['unstated', 'excluded', 'mixed'] as const)
      expect(guestPriceTotal([item, { ...item, tax }])?.qualifier).toContain('not established')
    expect(guestPriceTotal([{ ...item, tax: 'excluded' }], 400)).toEqual({
      cents: 2000,
      qualifier: 'before tax',
    })
    expect(guestPriceTotal([{ ...item, tax: 'unstated' }])?.qualifier).toContain('not established')
  })
  it('refuses negative prices, impossible discounts and fractional counts', () => {
    expect(guestPriceTotal([{ name: 'Cup', cents: -1, quantity: 1, tax: 'unstated' }])).toBeNull()
    expect(
      guestPriceTotal([{ name: 'Cup', cents: 100, quantity: 1.5, tax: 'unstated' }]),
    ).toBeNull()
    expect(
      guestPriceTotal([{ name: 'Cup', cents: 100, quantity: 1, tax: 'included' }], 200),
    ).toBeNull()
  })
})
