export const AI_COST_DECIMAL_SCALE = 8

export function aiCostDecimalToUnits(value: unknown): bigint {
  const text = String(value).trim().toLowerCase()
  const match = /^(\+?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(text)
  if (!match) throw new Error(`Invalid nonnegative AI cost: ${text}`)

  const whole = match[2] ?? '0'
  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent)) throw new Error(`Invalid AI cost exponent: ${text}`)

  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  const decimalPlaces = fraction.length - exponent
  if (decimalPlaces <= AI_COST_DECIMAL_SCALE) {
    return BigInt(digits) * 10n ** BigInt(AI_COST_DECIMAL_SCALE - decimalPlaces)
  }

  const excess = decimalPlaces - AI_COST_DECIMAL_SCALE
  const divisor = 10n ** BigInt(excess)
  const raw = BigInt(digits)
  if (raw % divisor !== 0n) {
    throw new Error(`AI cost exceeds ${AI_COST_DECIMAL_SCALE} decimal places: ${text}`)
  }
  return raw / divisor
}

export function aiCostUnitsToDecimal(units: bigint): string {
  if (units < 0n) throw new Error('AI cost units must be nonnegative')
  const digits = units.toString().padStart(AI_COST_DECIMAL_SCALE + 1, '0')
  return `${digits.slice(0, -AI_COST_DECIMAL_SCALE)}.${digits.slice(-AI_COST_DECIMAL_SCALE)}`
}

export function sumAiCostDecimals(values: Iterable<unknown>): string {
  let units = 0n
  for (const value of values) units += aiCostDecimalToUnits(value)
  return aiCostUnitsToDecimal(units)
}
