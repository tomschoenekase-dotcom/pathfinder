import { describe, expect, it } from 'vitest'

import { aiCostDecimalToUnits, aiCostUnitsToDecimal, sumAiCostDecimals } from './cost-decimal'

describe('AI cost decimal arithmetic', () => {
  it('sums fixed and scientific notation without a number round trip', () => {
    expect(sumAiCostDecimals(['0.10000001', '2e-8', 0.00000001])).toBe('0.10000004')
  })

  it('round-trips the database scale exactly', () => {
    expect(aiCostDecimalToUnits('12.34567890')).toBe(1_234_567_890n)
    expect(aiCostUnitsToDecimal(1_234_567_890n)).toBe('12.34567890')
  })

  it.each(['-0.1', 'not-a-cost', '0.000000001'])(
    'rejects invalid or unrepresentable cost %s',
    (value) => expect(() => aiCostDecimalToUnits(value)).toThrow(),
  )
})
