import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { db, recordWebsiteResearchReceiptAction, withTenantIsolationBypass } from '@pathfinder/db'

import { appRouter } from '../root'
import type { TRPCContext } from '../context'
import { executeWebsiteIntakeResearch } from './website-intake-research-service'
import { createWebsiteIntakeRuntimeDependencies } from './website-intake-runtime'

const enabled =
  process.env.RUN_WEBSITE_PDF_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_website_pdf_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const rootUrl = 'https://example.org/'
const validPdfUrl = 'https://example.org/visitor-guide.pdf'
const malformedPdfUrl = 'https://example.org/damaged-guide.pdf'
const unsupportedDocxUrl = 'https://example.org/accessibility-notes.docx'
const observedAt = new Date('2026-09-08T18:00:00.000Z')
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function escapePdfText(text: string) {
  return text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
}

function positionedPdfWithText(pageCount = 20, linesPerPage = 40) {
  const firstContentObject = 3 + pageCount
  const fontObject = firstContentObject + pageCount
  const pages = Array.from(
    { length: pageCount },
    (_, index) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`,
  )
  const contents = Array.from({ length: pageCount }, (_, pageIndex) => {
    const lines = Array.from({ length: linesPerPage }, (_, lineIndex) => {
      const text =
        pageIndex === 0 && lineIndex === 0
          ? 'Visitor guide: the quiet room is beside the north entrance.'
          : `Visitor guide review line ${pageIndex + 1}-${lineIndex + 1}: arrival guidance remains available for review.`
      return `(${escapePdfText(text)}) Tj 0 -16 Td`
    })
    const stream = `BT /F1 10 Tf 72 720 Td\n${lines.join('\n')}\nET`
    return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  })
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pages,
    ...contents,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(document)
}

function request(input: { operationId: string; tenantId: string; venueId: string; runId: string }) {
  return {
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    maxPages: 5,
    maxDepth: 1,
    maxBytesPerPage: 1_000_000,
    maxDurationMs: 30_000,
    maxCostUnits: 100,
    userAgent: 'TorchikoWebsitePdfProof/1.0',
    createdBy: 'website-pdf-proof-admin',
  }
}

function syntheticRuntime(fetchPage: ReturnType<typeof vi.fn>) {
  const runtime = createWebsiteIntakeRuntimeDependencies({
    userAgent: 'TorchikoWebsitePdfProof/1.0',
  })
  if (!runtime.extractPdfPage) throw new Error('Website runtime did not install PDF extraction.')
  return {
    ...runtime,
    resolveHostname: vi.fn(async () => ['93.184.216.34']),
    robots: { canFetch: vi.fn(async () => true) },
    fetchPage,
  }
}

describe.skipIf(!enabled)('website PDF disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('retains actual PDF review text without creating PDF claims, survives a PDF gap, and preserves exact read/replay scope', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
    const tenantId = `tenant-website-pdf-${suffix}`
    const venueId = `venue-website-pdf-${suffix}`
    const otherVenueId = `venue-website-pdf-other-${suffix}`
    const runId = `run-website-pdf-${suffix}`
    const legacyRunId = `run-website-pdf-legacy-${suffix}`
    const operationId = randomUUID()
    const legacyOperationId = randomUUID()
    const validPdfBytes = positionedPdfWithText()
    const malformedPdfBytes = Buffer.from('%PDF-1.4\nnot a complete portable document\n', 'utf8')
    const rootHtml = `<html><head><title>North Conservatory</title></head><body><main><p>Visitor arrival information.</p><a href="${validPdfUrl}">Guide</a><a href="${malformedPdfUrl}">Damaged guide</a><a href="${unsupportedDocxUrl}">Notes</a></main></body></html>`

    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Website PDF proof', slug: tenantId },
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'North Conservatory', slug: venueId },
          { id: otherVenueId, tenantId, name: 'Other conservatory', slug: otherVenueId },
        ],
      })
      await db.intakeRun.createMany({
        data: [
          {
            id: runId,
            tenantId,
            venueId,
            sourceKind: 'WEBSITE',
            status: 'AWAITING_REVIEW',
            displayName: 'Mixed HTML and PDF source proof',
            websiteUri: rootUrl,
            requestedBy: 'website-pdf-proof-admin',
          },
          {
            id: legacyRunId,
            tenantId,
            venueId,
            sourceKind: 'WEBSITE',
            status: 'AWAITING_REVIEW',
            displayName: 'Immutable policy one replay proof',
            websiteUri: rootUrl,
            requestedBy: 'website-pdf-proof-admin',
          },
        ],
      })
    })

    const fetchPage = vi.fn(async ({ url }: { url: string }) => {
      if (url === rootUrl)
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: rootHtml,
        }
      if (url === validPdfUrl)
        return { status: 200, headers: { 'content-type': 'application/pdf' }, body: validPdfBytes }
      if (url === malformedPdfUrl)
        return {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          body: malformedPdfBytes,
        }
      throw new Error(`Unexpected synthetic fetch: ${url}`)
    })
    const dependencies = syntheticRuntime(fetchPage)
    const execution = request({ operationId, tenantId, venueId, runId })

    await expect(
      executeWebsiteIntakeResearch({ db, request: execution, dependencies, now: () => observedAt }),
    ).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      replayed: false,
      evidenceRecorded: true,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
    expect(fetchPage.mock.calls.map(([call]) => call.url)).toEqual([
      rootUrl,
      validPdfUrl,
      malformedPdfUrl,
    ])

    const receipt = await db.intakeWebsiteResearchReceipt.findFirstOrThrow({
      where: { id: operationId, tenantId, venueId, runId },
    })
    expect(receipt).toMatchObject({
      outcome: 'SUCCEEDED',
      attemptedFetches: 3,
      fetchedPages: 2,
      fetchedBytes: rootHtml.length + validPdfBytes.byteLength + malformedPdfBytes.byteLength,
      errorCode: null,
    })
    expect(receipt.discoverySnapshot).toMatchObject({
      policyVersion: 2,
      items: expect.arrayContaining([
        expect.objectContaining({
          url: rootUrl,
          disposition: 'FETCHED_TEXT',
          exactByteHash: sha256(rootHtml),
        }),
        expect.objectContaining({
          url: validPdfUrl,
          disposition: 'PDF_TEXT_EXTRACTED',
          contentType: 'application/pdf',
          byteSize: validPdfBytes.byteLength,
          exactByteHash: sha256(validPdfBytes),
        }),
        expect.objectContaining({
          url: malformedPdfUrl,
          disposition: 'PDF_EXTRACTION_FAILED',
          contentType: 'application/pdf',
          byteSize: malformedPdfBytes.byteLength,
          exactByteHash: sha256(malformedPdfBytes),
          extractionFailureCode: 'PDF_PARSE_FAILED',
        }),
        expect.objectContaining({ url: unsupportedDocxUrl, disposition: 'UNSUPPORTED_DOCUMENT' }),
      ]),
    })
    expect(receipt.researchSnapshot).toMatchObject({
      pageTextEvidence: expect.arrayContaining([
        expect.objectContaining({ sourceUrl: rootUrl, extractionProfile: 'static-html-v1' }),
        expect.objectContaining({
          sourceUrl: validPdfUrl,
          exactByteHash: sha256(validPdfBytes),
          extractionProfile: 'pdfjs-document-v1',
          pdfPageCount: 20,
          fullCodePointCount: expect.any(Number),
          retainedCodePointCount: 20_000,
          truncated: true,
        }),
      ]),
    })
    const pdfEvidence = (
      receipt.researchSnapshot as { pageTextEvidence?: Array<Record<string, unknown>> }
    ).pageTextEvidence?.find((page) => page.sourceUrl === validPdfUrl)
    expect(pdfEvidence?.fullCodePointCount).toBeGreaterThan(20_000)
    const canonicalEvidence = await db.intakeEvidenceRecord.findMany({
      where: { tenantId, venueId, runId },
      orderBy: { locator: 'asc' },
    })
    expect(canonicalEvidence).toEqual([
      expect.objectContaining({ sourceKind: 'WEBSITE', locator: `${rootUrl}#title` }),
    ])
    expect(JSON.stringify(canonicalEvidence)).not.toContain(validPdfUrl)
    expect(receipt.candidateSnapshot).toEqual({ kind: 'TYPED_INTERMEDIATE', draftInput: null })

    const context = (isPlatformAdmin: boolean, userId: string | null = 'website-pdf-proof-admin') =>
      ({
        db,
        headers: new Headers(),
        session:
          userId === null
            ? { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false }
            : {
                userId,
                activeTenantId: tenantId,
                role: isPlatformAdmin ? null : 'STAFF',
                isPlatformAdmin,
              },
      }) as TRPCContext
    const admin = appRouter.createCaller(context(true)).admin
    const readerScope = { tenantId, venueId, runId, receiptId: operationId }
    const inventory = await admin.listWebsitePageText(readerScope)
    expect(inventory).toMatchObject({ status: 'RECORDED', sourceId: runId })
    if (inventory.status !== 'RECORDED') throw new Error('PDF review text was not retained.')
    const pdfMetadata = inventory.pages.find((page) => page.sourceUrl === validPdfUrl)
    expect(pdfMetadata).toMatchObject({
      exactByteHash: sha256(validPdfBytes),
      extractionProfile: 'pdfjs-document-v1',
      pdfPageCount: 20,
      retainedCodePointCount: 20_000,
      truncated: true,
    })
    expect(inventory.pages.find((page) => page.sourceUrl === malformedPdfUrl)).toBeUndefined()
    if (!pdfMetadata) throw new Error('PDF metadata was not retained.')
    const readInput = {
      ...readerScope,
      sourceUrl: validPdfUrl,
      expectedExactByteHash: pdfMetadata.exactByteHash,
      expectedRetainedTextHash: pdfMetadata.retainedTextHash,
      pageSize: 4_000,
    }
    const firstPage = await admin.readWebsitePageText(readInput)
    expect(firstPage).toMatchObject({
      status: 'RECORDED',
      extractionProfile: 'pdfjs-document-v1',
      pdfPageCount: 20,
      truncated: true,
      page: { offset: 0, limit: 4_000 },
    })
    if (firstPage.status !== 'RECORDED' || !firstPage.nextCursor) {
      throw new Error('Long PDF review text did not produce a bounded continuation.')
    }
    expect(firstPage.page.text).toContain('quiet room is beside the north entrance')
    const secondPage = await admin.readWebsitePageText({
      ...readInput,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.status).toBe('RECORDED')
    await expect(
      admin.readWebsitePageText({ ...readInput, expectedExactByteHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      admin.readWebsitePageText({ ...readInput, cursor: 'forged' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    for (const altered of [
      { tenantId: 'wrong-tenant' },
      { venueId: otherVenueId },
      { runId: legacyRunId },
    ]) {
      await expect(admin.listWebsitePageText({ ...readerScope, ...altered })).rejects.toMatchObject(
        {
          code: 'NOT_FOUND',
        },
      )
      await expect(admin.readWebsitePageText({ ...readInput, ...altered })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    }
    await expect(
      appRouter.createCaller(context(false)).admin.listWebsitePageText(readerScope),
    ).rejects.toThrow()
    await expect(
      appRouter.createCaller(context(false, null)).admin.readWebsitePageText(readInput),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    await expect(
      executeWebsiteIntakeResearch({ db, request: execution, dependencies, now: () => observedAt }),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED', replayed: true })
    expect(fetchPage).toHaveBeenCalledTimes(3)

    const legacyInput = {
      operationId: legacyOperationId,
      tenantId,
      venueId,
      runId: legacyRunId,
      requestHash: 'a'.repeat(64),
      sourceUriHash: sha256(rootUrl),
      bounds: {
        maxPages: 1,
        maxDepth: 1,
        maxBytesPerPage: 10_000,
        allowedHosts: ['example.org'],
        respectRobots: true as const,
        publishMode: 'DRAFT_ONLY' as const,
      },
      outcome: 'INACCESSIBLE' as const,
      discoverySnapshot: {
        policyVersion: 1 as const,
        observedAt: observedAt.toISOString(),
        omittedCount: 0,
        items: [
          {
            url: unsupportedDocxUrl,
            parentUrl: rootUrl,
            depth: 1,
            observedAt: observedAt.toISOString(),
            disposition: 'UNSUPPORTED_DOCUMENT' as const,
          },
        ],
      },
      evidence: [],
      discrepancies: [],
      attemptedFetches: 0,
      fetchedPages: 0,
      fetchedBytes: 0,
      estimatedCostUnits: 0,
      latencyMs: 0,
      errorCode: 'NO_ACCESSIBLE_PAGES' as const,
      createdBy: 'website-pdf-proof-admin',
    }
    await expect(recordWebsiteResearchReceiptAction(legacyInput, db)).resolves.toMatchObject({
      outcome: 'INACCESSIBLE',
      replayed: false,
    })
    await expect(recordWebsiteResearchReceiptAction(legacyInput, db)).resolves.toMatchObject({
      outcome: 'INACCESSIBLE',
      replayed: true,
    })
    const legacyReceipt = await db.intakeWebsiteResearchReceipt.findFirstOrThrow({
      where: { id: legacyOperationId, tenantId, venueId, runId: legacyRunId },
    })
    expect(legacyReceipt.discoverySnapshot).toMatchObject({ policyVersion: 1 })
  })
})
