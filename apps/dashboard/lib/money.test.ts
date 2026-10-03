import { describe, expect, it } from 'vitest'

import { formatMinorUnits } from './money'

describe('formatMinorUnits', () => {
  it('uses the currency exponent rather than a universal two decimals', () => {
    expect(formatMinorUnits(1500n, 'usd')).toBe('$15.00')
    expect(formatMinorUnits(1500n, 'jpy')).toBe('¥1,500')
    expect(formatMinorUnits(1500n, 'kwd')).toContain('1.500')
  })

  it('is exact for amounts that floats cannot represent', () => {
    expect(formatMinorUnits(9007199254740993n, 'usd')).toBe('$90,071,992,547,409.93')
  })

  it('handles zero, sub-unit and negative amounts', () => {
    expect(formatMinorUnits(0n, 'usd')).toBe('$0.00')
    expect(formatMinorUnits(5n, 'usd')).toBe('$0.05')
    expect(formatMinorUnits(-250n, 'usd')).toBe('-$2.50')
  })

  it('never misstates an unknown currency', () => {
    expect(formatMinorUnits(1500n, 'zz1')).toContain('1500')
  })
})
