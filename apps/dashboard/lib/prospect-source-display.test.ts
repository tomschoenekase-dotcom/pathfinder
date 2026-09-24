import { describe, expect, it } from 'vitest'
import {
  capturedWorkbookLocation,
  recordedWorkbookLocation,
  recordedHttpUrl,
  prospectDirectoryReturnHref,
  recordedContactRole,
  recordedResearchDate,
} from './prospect-source-display'

describe('source-only CRM presentation', () => {
  it('preserves an original calendar date without inventing a local time or shifting its day', () => {
    expect(
      recordedResearchDate(
        { normalized: { researchedAt: '2026-09-01' } },
        new Date('2026-09-01T00:00:00Z'),
      ),
    ).toBe('2026-09-01 (source date; time not recorded)')
  })
  it('keeps unknown or invalid dates unknown and retains genuine timestamp presentation', () => {
    expect(recordedResearchDate(null, null)).toBe('Date not recorded')
    expect(recordedResearchDate({ normalized: { researchedAt: '2026-02-30' } }, null)).toBe(
      'Date not recorded',
    )
    expect(recordedResearchDate({}, 'not a date')).toBe('Date not recorded')
    const timestamp = new Date('2026-09-21T03:00:00Z')
    expect(recordedResearchDate({}, timestamp)).toBe(timestamp.toLocaleString())
  })
  it('reads native lineage without requiring a duplicate legacy import row', () => {
    const source = {
      sheetName: 'Chicago Metro',
      originalRowNumber: 1368,
      rawRowSha256: 'a'.repeat(64),
    }
    expect(capturedWorkbookLocation({ raw: { _source: source } })).toEqual(source)
    expect(recordedWorkbookLocation({ _source: source })).toEqual(source)
    expect(capturedWorkbookLocation({ raw: {} })).toBeNull()
  })
  it('rejects invalid source locators', () => {
    for (const value of [
      null,
      [],
      {},
      { _source: { sheetName: 'A', originalRowNumber: '2' } },
      { _source: { sheetName: 'A', originalRowNumber: 1 } },
    ])
      expect(recordedWorkbookLocation(value)).toBeNull()
  })
  it('never turns arbitrary imported URL text into executable or credential-bearing links', () => {
    expect(recordedHttpUrl('https://museum.example/')).toBe('https://museum.example/')
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hello',
      '//museum.example',
      'https://username:password@museum.example',
      'not a url',
      null,
    ])
      expect(recordedHttpUrl(value)).toBeNull()
  })
  it('returns to an owned directory with only supported filters, not arbitrary destinations', () => {
    expect(
      prospectDirectoryReturnHref(
        '/admin/prospects',
        'search=Museum&sort=NAME_ASC&redirect=https://other.example',
      ),
    ).toBe('/admin/prospects?search=Museum&sort=NAME_ASC')
    expect(prospectDirectoryReturnHref('/admin/prospects', 'https://other.example')).toBe(
      '/admin/prospects',
    )
  })
  it('describes source roles without turning recorded general email into a named contact', () => {
    expect(recordedContactRole([{ sourceRole: 'GENERAL_CHANNEL_RECORDED' }])).toContain(
      'not assigned',
    )
    expect(recordedContactRole([])).toContain('not independently verified')
  })
})
