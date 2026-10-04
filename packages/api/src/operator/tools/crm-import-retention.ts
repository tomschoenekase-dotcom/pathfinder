import { createHash } from 'node:crypto'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Hash raw scalar cells, never expose their potentially private contents. */
export function sourceCellDigests(source: Record<string, unknown>) {
  return Object.entries(source).map(([column, value]) => {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
    return { column, characters: text.length, sha256: digest(text) }
  })
}

export function importFieldRetention(input: {
  source: unknown
  normalized: unknown
  mapping: unknown
  manifest: unknown
  rowNumber: number
  evidence: Array<{ capturedValue: unknown }>
}) {
  const manifest = object(input.manifest)
  const originalRows = Array.isArray(manifest.retentionDigests) ? manifest.retentionDigests : []
  const original = object(originalRows.find((value) => object(value).row === input.rowNumber))
  const expected = Array.isArray(original.fields) ? original.fields.map(object) : []
  const source = object(input.source)
  const normalized = object(input.normalized)
  const mapping = object(input.mapping)
  return sourceCellDigests(source).map((stored) => {
    const before = expected.find((field) => field.column === stored.column)
    const field =
      Object.entries(mapping).find(([, column]) => column === stored.column)?.[0] ?? null
    const canonical = field ? normalized[field] : undefined
    const normalizedText =
      typeof canonical === 'string'
        ? canonical
        : canonical === undefined
          ? null
          : JSON.stringify(canonical)
    const evidenceValue = input.evidence
      .map((entry) => object(entry.capturedValue)[stored.column])
      .find((value) => value !== undefined)
    const evidenceText =
      typeof evidenceValue === 'string'
        ? evidenceValue
        : evidenceValue === undefined
          ? null
          : JSON.stringify(evidenceValue)
    return {
      column: stored.column,
      mappedField: field,
      sourceCharacters: typeof before?.characters === 'number' ? before.characters : null,
      storedCharacters: stored.characters,
      storedSha256: stored.sha256,
      sourceRetention: !before
        ? ('ORIGINAL_NOT_RECORDED' as const)
        : before.sha256 === stored.sha256
          ? ('VERIFIED' as const)
          : ('MISMATCH' as const),
      normalizationChanged:
        normalizedText === null ? null : normalizedText !== source[stored.column],
      normalizedCharacters: normalizedText?.length ?? null,
      committedEvidenceCharacters: evidenceText?.length ?? null,
      committedEvidenceRetention:
        evidenceText === null
          ? ('NOT_AVAILABLE' as const)
          : digest(evidenceText) === stored.sha256
            ? ('VERIFIED' as const)
            : ('MISMATCH' as const),
    }
  })
}
