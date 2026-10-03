/**
 * Formats an integer amount of minor units without floating-point arithmetic. The currency's
 * exponent comes from the ICU currency data (USD 2, JPY 0, KWD 3), never from a fixed /100.
 * The decimal string is handed to Intl as an exact decimal. An unknown currency code is shown
 * as raw minor units so the amount is never silently misrepresented.
 */
export function formatMinorUnits(
  amountMinor: bigint | number | string,
  currency: string,
  locale = 'en-US',
): string {
  const code = currency.toUpperCase()
  const value = BigInt(amountMinor)
  let formatter: Intl.NumberFormat
  try {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
  } catch {
    return `${value.toString()} ${code} (minor units)`
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  const negative = value < 0n
  const padded = (negative ? -value : value).toString().padStart(digits + 1, '0')
  const whole = padded.slice(0, padded.length - digits)
  const fraction = digits > 0 ? padded.slice(padded.length - digits) : ''
  const decimal = `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
  // Intl.NumberFormat v3 accepts exact decimal strings; the DOM typings still say number.
  return formatter.format(decimal as unknown as number)
}
