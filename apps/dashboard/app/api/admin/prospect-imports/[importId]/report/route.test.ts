import { describe, expect, it } from 'vitest'

import { prospectImportReportCsvCell } from '../../../../../../lib/prospect-import-report-csv'

describe('prospect import report CSV safety', () => {
  it.each(['=1+1', '+cmd', '-formula', '@external'])(
    'neutralizes spreadsheet formula %s',
    (value) => {
      expect(prospectImportReportCsvCell(value)).toBe(`"'${value}"`)
    },
  )

  it('quotes embedded delimiters and quotes', () => {
    expect(prospectImportReportCsvCell('venue,"quoted"')).toBe('"venue,""quoted"""')
  })
})
