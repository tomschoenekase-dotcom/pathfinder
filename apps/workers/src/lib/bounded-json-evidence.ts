export type BoundedJsonEvidence<T> = {
  items: T[]
  jsonUtf8Bytes: number
  omitted: number
}

export function selectJsonEvidencePrefix<T>(
  items: readonly T[],
  maxUtf8Bytes: number,
): BoundedJsonEvidence<T> {
  if (!Number.isFinite(maxUtf8Bytes) || !Number.isInteger(maxUtf8Bytes) || maxUtf8Bytes < 2) {
    throw new RangeError('maxUtf8Bytes must be a finite integer of at least 2')
  }

  const selected: T[] = []
  for (const item of items) {
    const candidate = [...selected, item]
    const jsonUtf8Bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (jsonUtf8Bytes > maxUtf8Bytes) break
    selected.push(item)
  }

  return {
    items: selected,
    jsonUtf8Bytes: Buffer.byteLength(JSON.stringify(selected), 'utf8'),
    omitted: items.length - selected.length,
  }
}
