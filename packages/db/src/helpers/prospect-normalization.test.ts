import { describe, expect, it } from 'vitest'

import {
  normalizeProspectDomain,
  normalizeProspectEmail,
  normalizeProspectName,
  prospectSha256,
  scoreProspectDuplicate,
} from './prospect-normalization'

describe('prospect normalization', () => {
  it('normalizes names conservatively without erasing meaningful words', () => {
    expect(normalizeProspectName('The Musée & Park District, Inc.')).toBe(
      'the musee and park district',
    )
  })

  it('extracts comparable domains and rejects malformed URLs', () => {
    expect(normalizeProspectDomain('https://www.Example.org/path?q=1')).toBe('example.org')
    expect(normalizeProspectDomain('not a domain')).toBeNull()
  })

  it('normalizes only valid email addresses', () => {
    expect(normalizeProspectEmail(' INFO@Example.org ')).toBe('info@example.org')
    expect(normalizeProspectEmail('not-an-email')).toBeNull()
  })

  it('produces stable hashes independent of object key ordering', () => {
    expect(prospectSha256({ b: 2, a: 1 })).toBe(prospectSha256({ a: 1, b: 2 }))
  })

  it('keeps weak name-only matches below high-confidence auto-merge territory', () => {
    expect(scoreProspectDuplicate({ venueName: true })).toEqual({
      confidence: 0.78,
      reasons: ['normalized-venue-name'],
    })
    expect(scoreProspectDuplicate({ contactEmail: true }).confidence).toBe(1)
  })
})
