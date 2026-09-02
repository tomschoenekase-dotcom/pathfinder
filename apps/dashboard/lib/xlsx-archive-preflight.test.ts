import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'

import {
  inspectXlsxArchive,
  MAX_XLSX_ARCHIVE_ENTRIES,
  MAX_XLSX_EXPANDED_BYTES,
  XlsxArchivePreflightError,
} from './xlsx-archive-preflight'

function archive(entries: Array<{ name: string; compressedBytes: number; expandedBytes: number }>) {
  const encoder = new TextEncoder()
  const names = entries.map((entry) => encoder.encode(entry.name))
  const centralBytes = entries.reduce(
    (total, _entry, index) => total + 46 + names[index]!.length,
    0,
  )
  const buffer = new ArrayBuffer(centralBytes + 22)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let cursor = 0
  entries.forEach((entry, index) => {
    const name = names[index]!
    view.setUint32(cursor, 0x02014b50, true)
    view.setUint32(cursor + 20, entry.compressedBytes, true)
    view.setUint32(cursor + 24, entry.expandedBytes, true)
    view.setUint16(cursor + 28, name.length, true)
    bytes.set(name, cursor + 46)
    cursor += 46 + name.length
  })
  view.setUint32(cursor, 0x06054b50, true)
  view.setUint16(cursor + 8, entries.length, true)
  view.setUint16(cursor + 10, entries.length, true)
  view.setUint32(cursor + 12, centralBytes, true)
  view.setUint32(cursor + 16, 0, true)
  return buffer
}

describe('inspectXlsxArchive', () => {
  it('accepts an actual SheetJS workbook archive', () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['venue_name', 'city'],
        ['Northstar', 'Chicago'],
      ]),
      'Prospects',
    )
    const generated = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    expect(inspectXlsxArchive(generated)).toMatchObject({ entries: expect.any(Number) })
  })

  it('totals a bounded single-disk XLSX central directory without decompressing it', () => {
    expect(
      inspectXlsxArchive(
        archive([
          { name: '[Content_Types].xml', compressedBytes: 200, expandedBytes: 500 },
          { name: 'xl/worksheets/sheet1.xml', compressedBytes: 1_000, expandedBytes: 5_000 },
        ]),
      ),
    ).toEqual({ entries: 2, expandedBytes: 5_500 })
  })

  it('rejects a compressed workbook whose declared expansion crosses 150 MB', () => {
    expect(() =>
      inspectXlsxArchive(
        archive([
          {
            name: 'xl/worksheets/sheet1.xml',
            compressedBytes: 1,
            expandedBytes: 100 * 1024 * 1024,
          },
          {
            name: 'xl/worksheets/sheet2.xml',
            compressedBytes: 1,
            expandedBytes: MAX_XLSX_EXPANDED_BYTES - 100 * 1024 * 1024 + 1,
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXPANDED_TOO_LARGE' }))
  })

  it('rejects malformed, multi-disk, ZIP64, and trailing-data archives', () => {
    const malformed = archive([{ name: 'xl/workbook.xml', compressedBytes: 1, expandedBytes: 1 }])
    new DataView(malformed).setUint16(malformed.byteLength - 18, 1, true)
    expect(() => inspectXlsxArchive(malformed)).toThrowError(XlsxArchivePreflightError)

    const zip64 = archive([{ name: 'xl/workbook.xml', compressedBytes: 1, expandedBytes: 1 }])
    new DataView(zip64).setUint16(zip64.byteLength - 14, 0xffff, true)
    new DataView(zip64).setUint16(zip64.byteLength - 12, 0xffff, true)
    expect(() => inspectXlsxArchive(zip64)).toThrowError(XlsxArchivePreflightError)

    const trailing = new Uint8Array(
      archive([{ name: 'xl/workbook.xml', compressedBytes: 1, expandedBytes: 1 }]).byteLength + 1,
    )
    trailing.set(
      new Uint8Array(archive([{ name: 'xl/workbook.xml', compressedBytes: 1, expandedBytes: 1 }])),
    )
    expect(() => inspectXlsxArchive(trailing.buffer)).toThrowError(XlsxArchivePreflightError)
  })

  it('fails closed before walking an excessive entry count', () => {
    const tooMany = archive([{ name: 'xl/workbook.xml', compressedBytes: 1, expandedBytes: 1 }])
    const view = new DataView(tooMany)
    view.setUint16(tooMany.byteLength - 14, MAX_XLSX_ARCHIVE_ENTRIES + 1, true)
    view.setUint16(tooMany.byteLength - 12, MAX_XLSX_ARCHIVE_ENTRIES + 1, true)
    expect(() => inspectXlsxArchive(tooMany)).toThrowError(
      expect.objectContaining({ code: 'TOO_MANY_ENTRIES' }),
    )
  })
})
