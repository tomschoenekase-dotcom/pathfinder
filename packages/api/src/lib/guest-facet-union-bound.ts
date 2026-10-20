type RecordChars = { key: string; chars: number }

/**
 * Prove overflow only: each standalone size minus a renderer-measured overhead is a
 * nonnegative lower bound on that record's unchanged segment in the finite union.
 * Unknown/invalid sizes deliberately fall back to the existing exact renderer.
 */
export function facetUnionCannotFit(
  records: readonly RecordChars[],
  requiredKeys: ReadonlySet<string>,
  maxChars: number,
  standaloneOverhead: number,
): boolean {
  if (
    !Number.isSafeInteger(maxChars) ||
    maxChars < 0 ||
    !Number.isSafeInteger(standaloneOverhead) ||
    standaloneOverhead < 0
  )
    return false
  let remaining = maxChars
  let exceeds = false
  for (const row of records) {
    if (!requiredKeys.has(row.key)) continue
    if (!Number.isSafeInteger(row.chars) || row.chars < 0) return false
    const lowerBound = Math.max(0, row.chars - standaloneOverhead)
    // Saturate the sum without overflowing or rounding large sums. Continue validating
    // the remaining selected rows; malformed cached metadata never grants a proof.
    if (!exceeds) {
      if (lowerBound > remaining) exceeds = true
      else remaining -= lowerBound
    }
  }
  return exceeds
}
