import { describe, expect, it } from 'vitest'

import { WebsiteSourceDiscovery } from './intake-engine'

const observedAt = '2026-09-08T12:00:00.000Z'
const hash = 'a'.repeat(64)
const item = {
  url: 'https://example.org/menu.pdf',
  parentUrl: 'https://example.org/',
  depth: 1,
  observedAt,
}

function collection(policyVersion: 1 | 2, entry: Record<string, unknown>) {
  return { policyVersion, observedAt, items: [{ ...item, ...entry }], omittedCount: 0 }
}

describe('website PDF discovery contract', () => {
  it('keeps policy 1 compatible with its frozen outcomes and rejects policy 2 outcomes', () => {
    expect(
      WebsiteSourceDiscovery.safeParse(
        collection(1, {
          disposition: 'UNSUPPORTED_DOCUMENT',
        }),
      ).success,
    ).toBe(true)
    expect(
      WebsiteSourceDiscovery.safeParse(
        collection(1, {
          disposition: 'FETCHED_TEXT',
          contentType: 'text/html',
          byteSize: 10,
          exactByteHash: hash,
        }),
      ).success,
    ).toBe(true)
    for (const disposition of ['PDF_TEXT_EXTRACTED', 'PDF_EXTRACTION_FAILED', 'TIME_LIMIT']) {
      expect(
        WebsiteSourceDiscovery.safeParse(
          collection(1, {
            disposition,
            ...(disposition === 'TIME_LIMIT'
              ? {}
              : {
                  contentType: 'application/pdf',
                  byteSize: 10,
                  exactByteHash: hash,
                  ...(disposition === 'PDF_EXTRACTION_FAILED'
                    ? { extractionFailureCode: 'PDF_PARSE_FAILED' }
                    : {}),
                }),
          }),
        ).success,
      ).toBe(false)
    }
  })

  it('requires PDF MIME and exact received-byte provenance for policy 2 success', () => {
    const valid = {
      disposition: 'PDF_TEXT_EXTRACTED',
      contentType: 'application/pdf',
      byteSize: 1_024,
      exactByteHash: hash,
    }
    expect(WebsiteSourceDiscovery.safeParse(collection(2, valid)).success).toBe(true)
    for (const patch of [
      { contentType: 'text/plain' },
      { contentType: undefined },
      { byteSize: undefined },
      { exactByteHash: undefined },
      { extractionFailureCode: 'PDF_PARSE_FAILED' },
    ]) {
      expect(WebsiteSourceDiscovery.safeParse(collection(2, { ...valid, ...patch })).success).toBe(
        false,
      )
    }
  })

  it('requires a failure code iff policy 2 PDF extraction failed', () => {
    const valid = {
      disposition: 'PDF_EXTRACTION_FAILED',
      contentType: 'application/pdf',
      byteSize: 1_024,
      exactByteHash: hash,
      extractionFailureCode: 'PDF_PASSWORD_REQUIRED',
    }
    expect(WebsiteSourceDiscovery.safeParse(collection(2, valid)).success).toBe(true)
    expect(
      WebsiteSourceDiscovery.safeParse(
        collection(2, { ...valid, extractionFailureCode: undefined }),
      ).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse(
        collection(2, { ...valid, extractionFailureCode: 'NOT_A_PDF_FAILURE' }),
      ).success,
    ).toBe(false)
  })

  it('records TIME_LIMIT without pretending that bytes were received', () => {
    expect(
      WebsiteSourceDiscovery.safeParse(collection(2, { disposition: 'TIME_LIMIT' })).success,
    ).toBe(true)
    for (const patch of [
      { byteSize: 0, exactByteHash: hash },
      { byteSize: 10 },
      { exactByteHash: hash },
    ]) {
      expect(
        WebsiteSourceDiscovery.safeParse(collection(2, { disposition: 'TIME_LIMIT', ...patch }))
          .success,
      ).toBe(false)
    }
  })
})
