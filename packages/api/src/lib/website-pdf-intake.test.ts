import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  WebsiteIntakeBounds,
  type WebsitePdfExtractionFailure,
} from '@pathfinder/contracts/intake-engine'
import { buildWebsiteIntakeProposal, type WebsiteIntakeDependencies } from './website-intake'

const root = 'https://example.org/'
const pdf = `${root}guide.pdf`
const now = new Date('2026-09-08T10:00:00.000Z')
const bytes = new Uint8Array([37, 80, 68, 70, 45, 255, 0])
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function request(maxPages = 10) {
  return {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    sourceId: 'run-a',
    startUrl: root,
    bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'], maxPages }),
    userAgent: 'SyntheticIntake/1',
  }
}
function dependencies(
  overrides: Partial<WebsiteIntakeDependencies> = {},
): WebsiteIntakeDependencies {
  return {
    resolveHostname: vi.fn(async () => ['93.184.216.34']),
    robots: { canFetch: vi.fn(async () => true) },
    fetchPage: vi.fn(async ({ url }) => ({
      status: 200,
      headers: { 'content-type': url === root ? 'text/html' : 'application/pdf' },
      body: url === root ? '<p>Welcome</p>' : bytes,
    })),
    extractPage: vi.fn(async () => ({
      links: [pdf],
      facts: [],
      readableText: 'Welcome',
      extractionProfile: 'static-html-v1' as const,
    })),
    extractPdfPage: vi.fn(async () => ({
      outcome: 'SUCCEEDED' as const,
      readableText: 'Accessible entrance beside the fountain.',
      pdfPageCount: 2,
    })),
    now: () => now,
    ...overrides,
  }
}

describe('PDF-aware bounded website intake', () => {
  it('passes exact PDF bytes and retains bounded review prose without generating canonical claims', async () => {
    const deps = dependencies({
      extractPdfPage: vi.fn(async () => ({
        outcome: 'SUCCEEDED' as const,
        readableText: '🌿'.repeat(20_001),
        pdfPageCount: 2,
      })),
    })
    const result = await buildWebsiteIntakeProposal(request(), deps)
    expect(deps.extractPdfPage).toHaveBeenCalledWith({
      url: pdf,
      bytes: Buffer.from(bytes),
      timeoutMs: 15_000,
    })
    expect(result.intermediate.discovery).toMatchObject({
      policyVersion: 2,
      items: [
        { disposition: 'FETCHED_TEXT' },
        {
          url: pdf,
          disposition: 'PDF_TEXT_EXTRACTED',
          contentType: 'application/pdf',
          exactByteHash: hash(bytes),
          byteSize: bytes.length,
        },
      ],
    })
    expect(result.intermediate.pageTextEvidence?.[1]).toMatchObject({
      sourceUrl: pdf,
      exactByteHash: hash(bytes),
      extractionProfile: 'pdfjs-document-v1',
      pdfPageCount: 2,
      fullCodePointCount: 20_001,
      retainedCodePointCount: 20_000,
      truncated: true,
    })
    expect(result.intermediate.citations).toEqual([])
    expect(result.intermediate.evidence).toEqual([])
    expect(result.packageBinding).toEqual({ kind: 'TYPED_INTERMEDIATE', draftInput: null })
    expect(result.execution).toEqual({
      autoPublish: false,
      autoApply: false,
      lifecycleCommands: [],
    })
  })

  it('uses received MIME for extensionless PDFs and misleading PDF filenames', async () => {
    const extensionless = `${root}download`
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) => ({
        status: 200,
        headers: {
          'content-type': url === extensionless ? 'application/pdf; charset=binary' : 'text/html',
        },
        body: url === extensionless ? bytes : '<p>HTML</p>',
      })),
      extractPage: vi.fn(async ({ url }) => ({
        links: url === root ? [extensionless, pdf] : [],
        facts: [],
        readableText: 'HTML',
        extractionProfile: 'static-html-v1' as const,
      })),
    })
    const result = await buildWebsiteIntakeProposal(request(), deps)
    expect(deps.extractPdfPage).toHaveBeenCalledOnce()
    expect(deps.extractPdfPage).toHaveBeenCalledWith(
      expect.objectContaining({ url: extensionless, bytes }),
    )
    expect(result.intermediate.discovery?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: pdf, disposition: 'FETCHED_TEXT' })]),
    )
  })

  it.each<WebsitePdfExtractionFailure>([
    'PDF_PASSWORD_REQUIRED',
    'PDF_NO_EXTRACTABLE_TEXT',
    'PDF_PARSE_FAILED',
    'PDF_TOO_MANY_PAGES',
    'PDF_EXTRACTION_TIMEOUT',
    'TEXT_TOO_LARGE',
  ])('retains independent HTML and an explicit %s PDF gap', async (errorCode) => {
    const result = await buildWebsiteIntakeProposal(
      request(),
      dependencies({
        extractPdfPage: vi.fn(async () => ({ outcome: 'FAILED' as const, errorCode })),
      }),
    )
    expect(result.intermediate.pages).toHaveLength(1)
    expect(result.intermediate.pageTextEvidence).toHaveLength(1)
    expect(result.intermediate.discovery?.items[1]).toMatchObject({
      disposition: 'PDF_EXTRACTION_FAILED',
      extractionFailureCode: errorCode,
      exactByteHash: hash(bytes),
    })
  })

  it('redacts unexpected PDF parser errors and retains independently collected HTML', async () => {
    const result = await buildWebsiteIntakeProposal(
      request(),
      dependencies({
        extractPdfPage: vi.fn(async () => {
          throw new Error('private provider details')
        }),
      }),
    )
    expect(result.intermediate.discovery?.items[1]).toMatchObject({
      disposition: 'PDF_EXTRACTION_FAILED',
      extractionFailureCode: 'PDF_PARSE_FAILED',
    })
    expect(JSON.stringify(result)).not.toContain('private provider details')
  })

  it('keeps completed HTML when a PDF consumes the remaining deadline and marks unattempted references', async () => {
    let clock = now.getTime()
    const deps = dependencies({
      now: () => new Date(clock),
      extractPage: vi.fn(async () => ({
        links: [pdf, `${root}later`],
        facts: [],
        readableText: 'Welcome',
        extractionProfile: 'static-html-v1' as const,
      })),
      extractPdfPage: vi.fn(async () => {
        clock += 100
        return { outcome: 'SUCCEEDED' as const, readableText: 'Too late', pdfPageCount: 1 }
      }),
    })
    const result = await buildWebsiteIntakeProposal({ ...request(), maxDurationMs: 100 }, deps)
    expect(deps.extractPdfPage).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 100 }))
    expect(result.intermediate.pages).toHaveLength(1)
    expect(result.intermediate.discovery?.items.slice(1)).toMatchObject([
      { disposition: 'PDF_EXTRACTION_FAILED', extractionFailureCode: 'PDF_EXTRACTION_TIMEOUT' },
      { url: `${root}later`, disposition: 'TIME_LIMIT' },
    ])
    expect(result.intermediate.discovery?.items[2]).not.toHaveProperty('byteSize')
    expect(deps.fetchPage).toHaveBeenCalledTimes(2)
  })

  it('enforces robots, page budget, and byte bounds before PDF extraction', async () => {
    const denied = dependencies({ robots: { canFetch: vi.fn(async ({ url }) => url !== pdf) } })
    expect(
      (await buildWebsiteIntakeProposal(request(), denied)).intermediate.discovery?.items[1]
        ?.disposition,
    ).toBe('ROBOTS_DENIED')
    expect(denied.extractPdfPage).not.toHaveBeenCalled()
    const budget = dependencies()
    expect(
      (await buildWebsiteIntakeProposal(request(1), budget)).intermediate.discovery?.items[1]
        ?.disposition,
    ).toBe('PAGE_LIMIT')
    expect(budget.extractPdfPage).not.toHaveBeenCalled()
    const overflow = dependencies({
      fetchPage: vi.fn(async () => ({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: bytes,
      })),
    })
    await expect(
      buildWebsiteIntakeProposal(
        {
          ...request(),
          bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'], maxBytesPerPage: 2 }),
        },
        overflow,
      ),
    ).rejects.toThrow(/byte/)
    expect(overflow.extractPdfPage).not.toHaveBeenCalled()
  })

  it('rejects a PDF redirect to a private host before parser invocation', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async () => ({
        status: 302,
        headers: { location: 'http://127.0.0.1/guide.pdf' },
        body: '',
      })),
    })
    await expect(buildWebsiteIntakeProposal({ ...request(), startUrl: pdf }, deps)).rejects.toThrow(
      /host|public/i,
    )
    expect(deps.extractPdfPage).not.toHaveBeenCalled()
  })
})
