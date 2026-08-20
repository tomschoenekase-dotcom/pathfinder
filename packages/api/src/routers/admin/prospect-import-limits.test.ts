import { describe, expect, it } from 'vitest'

import {
  assertProspectImportManifest,
  assertProspectSourceRow,
  chunkProspectImportRows,
  PROSPECT_IMPORT_LIMITS,
} from './prospect-import-limits'

describe('prospect import server limits', () => {
  it('bounds XLSX expansion independently of upload size', () => {
    expect(() =>
      assertProspectImportManifest({
        fileSize: 1024,
        expandedXlsxBytes: PROSPECT_IMPORT_LIMITS.maxExpandedXlsxBytes + 1,
        sheets: [{ detectedRows: 10, columns: ['Venue'] }],
      }),
    ).toThrow('Expanded XLSX size')
  })

  it('keeps formula-like text inert while rejecting nested values', () => {
    expect(() =>
      assertProspectSourceRow({ Venue: '=HYPERLINK("https://evil.invalid")' }),
    ).not.toThrow()
    expect(() => assertProspectSourceRow({ Venue: { formula: '=1+1' } })).toThrow(
      'scalar workbook cell',
    )
  })

  it('deterministically batches a synthetic 20,000-row CSV-shaped stream', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => ({
      Venue: `Synthetic Venue ${index + 1}`,
      Email: `fixture-${index + 1}@example.invalid`,
    }))
    for (const row of rows) assertProspectSourceRow(row)
    const batches = chunkProspectImportRows(rows)
    expect(batches).toHaveLength(80)
    expect(batches.every((batch) => batch.length === 250)).toBe(true)
    expect(batches.flat()).toHaveLength(20_000)
  })
})
