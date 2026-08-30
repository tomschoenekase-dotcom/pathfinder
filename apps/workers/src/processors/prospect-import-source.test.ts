import { describe, expect, it } from 'vitest'
// Node16 module interop requires this form for SheetJS in both tsc and Vitest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import XLSX = require('xlsx')

import { inspectProspectWorkbookBytes, quarantinedSourceRowFailure } from './prospect-import-source'

describe('server-owned prospect workbook inspection', () => {
  it('builds code-only quarantine evidence without exception or row content', () => {
    const secret = 'postgres://operator:secret@example.test/torchiko'
    const failure = quarantinedSourceRowFailure(secret, 42)

    expect(failure).toEqual({
      rowFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      errors: ['server-quarantine:unsafe-source-row'],
      errorCode: 'UNSAFE_SOURCE_ROW',
      errorMessage: 'Source row failed bounded server validation.',
    })
    expect(JSON.stringify(failure)).not.toContain(secret)
  })

  it('inspects a deterministic 20,000-row XLSX within bounded metadata', async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => ({
      venue_name: `Venue ${index}`,
      owner_name: `Organization ${Math.floor(index / 2)}`,
      website: `https://venue-${index}.example.test`,
      contact_email: `contact-${index}@example.test`,
    }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Prospects')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true })
    const inspected = await inspectProspectWorkbookBytes(Buffer.from(bytes), 'xlsx')
    expect(inspected.totalRows).toBe(20_000)
    expect(inspected.sheets).toEqual([
      expect.objectContaining({
        sheetName: 'Prospects',
        rows: 20_000,
        columns: ['venue_name', 'owner_name', 'website', 'contact_email'],
      }),
    ])
    expect(inspected.expanded).toBeGreaterThan(bytes.byteLength)
  }, 30_000)

  it('rejects a CSV beyond the 100,000-row server limit', async () => {
    const lines = ['venue_name']
    for (let index = 0; index < 100_001; index += 1) lines.push(`Venue ${index}`)
    await expect(
      inspectProspectWorkbookBytes(Buffer.from(lines.join('\n'), 'utf8'), 'csv'),
    ).rejects.toThrow('total row limit')
  }, 30_000)
})
