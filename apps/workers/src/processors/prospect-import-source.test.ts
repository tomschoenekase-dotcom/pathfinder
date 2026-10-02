import { describe, expect, it } from 'vitest'
// Node16 module interop requires this form for SheetJS in both tsc and Vitest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import XLSX = require('xlsx')

import {
  inertCell,
  inspectProspectWorkbookBytes,
  normalizedRow,
  quarantinedSourceRowFailure,
} from './prospect-import-source'

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

describe('spreadsheet cells are data', () => {
  it('keeps a formula-looking cell as text and never evaluates it', () => {
    for (const cell of ['=1+1', '+SUM(A1)', '-2+3', '@HYPERLINK("x")']) {
      expect(inertCell(cell)).toBe(cell)
    }
    const row = normalizedRow(
      { Venue: '=HYPERLINK("https://evil.example","x")', Notes: '@cmd' },
      { venueName: 'Venue', notes: 'Notes' },
      'Sheet 1',
    )
    expect(row.venueName).toBe('=HYPERLINK("https://evil.example","x")')
    expect(row.notes).toBe('@cmd')
  })

  it('reads a workbook formula cell as its cached text, never as a formula', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Venue', 'Notes']])
    sheet.A2 = { t: 's', v: '=1+1' }
    sheet.B2 = { t: 'n', v: 4, f: 'SUM(1,3)' }
    sheet['!ref'] = 'A1:B2'
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Data')
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const parsed = XLSX.read(buffer, { type: 'buffer', cellFormula: false, dense: true })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Data!, {
      defval: null,
      raw: false,
    })
    expect(rows[0]!.Venue).toBe('=1+1')
    // The formula text is dropped (cellFormula: false); only the cached value is read.
    expect(rows[0]!.Notes).toBe('4')
  })

  it('omits blank cells so a blank can never erase a stored value', () => {
    const row = normalizedRow(
      { Venue: 'Sample Venue', City: '', Website: null, Notes: '   ' },
      { venueName: 'Venue', city: 'City', website: 'Website', notes: 'Notes' },
      'Sheet 1',
    )
    expect(row).not.toHaveProperty('city')
    expect(row).not.toHaveProperty('website')
    expect(row).not.toHaveProperty('notes')
  })

  it('ignores a company priority column that is not a mapped field', () => {
    const row = normalizedRow(
      { Venue: 'Sample Venue', company_priority: 'Top priority for the founder this quarter' },
      { venueName: 'Venue', company_priority: 'company_priority' },
      'Sheet 1',
    )
    expect(row).not.toHaveProperty('company_priority')
    expect(row).not.toHaveProperty('outreachPriority')
  })
})
