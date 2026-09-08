import { describe, expect, it } from 'vitest'
import { WebsitePageTextEvidence, WebsitePageTextEvidenceCollection } from './intake-engine'

const page = {
  sourceUrl: 'https://example.org/',
  exactByteHash: 'a'.repeat(64),
  capturedAt: '2026-09-08T10:00:00.000Z',
  extractionProfile: 'static-html-v1',
  text: '🌿',
  normalizedTextHash: 'b'.repeat(64),
  retainedTextHash: 'b'.repeat(64),
  fullCodePointCount: 1,
  retainedCodePointCount: 1,
  truncated: false,
}
describe('retained website text contract', () => {
  it('validates Unicode counts and explicit truncation metadata', () => {
    expect(WebsitePageTextEvidence.safeParse(page).success).toBe(true)
    for (const patch of [
      { retainedCodePointCount: 2 },
      { fullCodePointCount: 0 },
      { truncated: true },
      { retainedTextHash: 'c'.repeat(64) },
    ]) {
      expect(WebsitePageTextEvidence.safeParse({ ...page, ...patch }).success).toBe(false)
    }
  })
  it('rejects unsafe provenance URLs and authority-bearing additive fields', () => {
    for (const sourceUrl of [
      'https://user:secret@example.org/',
      'http://127.0.0.1/',
      'https://example.org/?token=secret',
      'https://example.org:8443/',
      'javascript:alert(1)',
    ]) {
      expect(WebsitePageTextEvidence.safeParse({ ...page, sourceUrl }).success).toBe(false)
    }
    expect(WebsitePageTextEvidence.safeParse({ ...page, approved: true }).success).toBe(false)
  })
  it('bounds per-page and total retention and rejects duplicate URLs', () => {
    expect(WebsitePageTextEvidenceCollection.safeParse([page, page]).success).toBe(false)
    const full = {
      ...page,
      text: 'x'.repeat(20_000),
      fullCodePointCount: 20_000,
      retainedCodePointCount: 20_000,
    }
    const pages = Array.from({ length: 6 }, (_, index) => ({
      ...full,
      sourceUrl: `https://example.org/${index}`,
    }))
    expect(WebsitePageTextEvidenceCollection.safeParse(pages.slice(0, 5)).success).toBe(true)
    expect(WebsitePageTextEvidenceCollection.safeParse(pages).success).toBe(false)
    expect(
      WebsitePageTextEvidence.safeParse({
        ...full,
        text: 'x'.repeat(20_001),
        fullCodePointCount: 20_001,
        retainedCodePointCount: 20_001,
      }).success,
    ).toBe(false)
  })

  it('requires an actual page count exactly for the PDF extraction profile', () => {
    expect(
      WebsitePageTextEvidence.safeParse({
        ...page,
        extractionProfile: 'pdfjs-document-v1',
        pdfPageCount: 12,
      }).success,
    ).toBe(true)
    expect(
      WebsitePageTextEvidence.safeParse({ ...page, extractionProfile: 'pdfjs-document-v1' })
        .success,
    ).toBe(false)
    expect(WebsitePageTextEvidence.safeParse({ ...page, pdfPageCount: 1 }).success).toBe(false)
    for (const pdfPageCount of [0, 201, 1.5]) {
      expect(
        WebsitePageTextEvidence.safeParse({
          ...page,
          extractionProfile: 'pdfjs-document-v1',
          pdfPageCount,
        }).success,
      ).toBe(false)
    }
  })
})
