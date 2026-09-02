import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordIntakeFileExtractionReceiptAction } from '@pathfinder/db'

import {
  createPdfLoadingTaskCleanup,
  executeIntakeFileExtraction,
} from './intake-file-extraction-service'

vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  return { ...actual, recordIntakeFileExtractionReceiptAction: vi.fn() }
})

const recordReceipt = vi.mocked(recordIntakeFileExtractionReceiptAction)
const operationId = '568c2e1a-8ece-47ad-98dc-e4bde64872ca'

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function pdfWithText(text: string, pageCount = 1) {
  const escaped = text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
  const firstContentObject = 3 + pageCount
  const fontObject = firstContentObject + pageCount
  const pageObjects = Array.from({ length: pageCount }, (_, index) => {
    const contentObject = firstContentObject + index
    return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`
  })
  const contentObjects = Array.from(
    { length: pageCount },
    () => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  )
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pageObjects,
    ...contentObjects,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document)
}

function database(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    intakeRun: {
      findFirst: vi.fn(async () => ({
        upload: {
          id: 'upload-a',
          status: 'AWAITING_REVIEW',
          objectKey: 'staging/intake/upload-a',
          objectGeneration: '1c246794-ecde-4666-a925-47de3c9f3e0b',
          storageVersionId: 'version-a',
          sha256: sha256(bytes),
          byteSize: bytes.byteLength,
          mimeType: 'text/plain',
          ...overrides,
        },
      })),
    },
  }
}

function storage(bytes: Uint8Array) {
  return {
    send: vi.fn(async () => ({
      Body: (async function* () {
        yield bytes.slice(0, Math.max(1, Math.floor(bytes.byteLength / 2)))
        yield bytes.slice(Math.max(1, Math.floor(bytes.byteLength / 2)))
      })(),
    })),
  }
}

describe('deterministic intake file extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STORAGE_BUCKET = 'test-bucket'
    process.env.STORAGE_REGION = 'us-east-1'
    process.env.STORAGE_ACCESS_KEY_ID = 'test-access'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret'
    recordReceipt.mockResolvedValue({
      receiptId: operationId,
      outcome: 'SUCCEEDED',
      createdAt: new Date('2026-08-29T03:30:00.000Z'),
      replayed: false,
      reviewRequired: true,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
  })

  it('deduplicates and contains asynchronous PDF loading-task cleanup failures', async () => {
    const destroy = vi.fn(async () => {
      throw new Error('private cleanup failure')
    })
    const cleanup = createPdfLoadingTaskCleanup({ destroy })

    await expect(Promise.all([cleanup(), cleanup()])).resolves.toEqual([undefined, undefined])
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('rechecks exact bytes and records normalized UTF-8 text without authority', async () => {
    const bytes = Buffer.from('\uFEFFLine one\r\nLine two\r', 'utf8')
    const result = await executeIntakeFileExtraction({
      db: database(bytes) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      operationId,
      createdBy: 'admin-a',
      storage: storage(bytes),
    })

    expect(result).toMatchObject({ receiptId: operationId, reviewRequired: true })
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        sourceSha256: sha256(bytes),
        sourceByteSize: bytes.byteLength,
        sourceMimeType: 'text/plain',
        outcome: 'SUCCEEDED',
        extractedText: 'Line one\nLine two\n',
        extractedTextHash: sha256(Buffer.from('Line one\nLine two\n')),
        extractedCharacterCount: 18,
        extractedLineCount: 3,
      }),
    )
  })

  it('extracts text from an exact verified PDF without OCR or authority', async () => {
    const bytes = pdfWithText('Welcome to the museum')
    const result = await executeIntakeFileExtraction({
      db: database(bytes, { mimeType: 'application/pdf' }) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      operationId,
      createdBy: 'admin-a',
      storage: storage(bytes),
    })

    expect(result).toMatchObject({ receiptId: operationId, reviewRequired: true })
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        sourceSha256: sha256(bytes),
        sourceMimeType: 'application/pdf',
        extractor: 'pathfinder-pdfjs-document',
        extractorVersion: '1',
        outcome: 'SUCCEEDED',
        extractedText: 'Welcome to the museum',
        extractedTextHash: sha256(Buffer.from('Welcome to the museum')),
        extractedCharacterCount: 21,
        extractedLineCount: 1,
      }),
    )
  })

  it('records a bounded failure when a verified PDF has no extractable text', async () => {
    const bytes = pdfWithText('')
    await executeIntakeFileExtraction({
      db: database(bytes, { mimeType: 'application/pdf' }) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      operationId,
      createdBy: 'admin-a',
      storage: storage(bytes),
    })

    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'PDF_NO_EXTRACTABLE_TEXT',
        extractedCharacterCount: 0,
        extractedLineCount: 0,
      }),
    )
  })

  it('stops before page extraction when a verified PDF exceeds the page boundary', async () => {
    const bytes = pdfWithText('Bounded text', 201)
    await executeIntakeFileExtraction({
      db: database(bytes, { mimeType: 'application/pdf' }) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      operationId,
      createdBy: 'admin-a',
      storage: storage(bytes),
    })

    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'PDF_TOO_MANY_PAGES',
        extractedCharacterCount: 0,
        extractedLineCount: 0,
      }),
    )
  })

  it('records a fixed parse failure without retaining parser details', async () => {
    const bytes = Buffer.from('%PDF-1.4\nnot-a-valid-document')
    await executeIntakeFileExtraction({
      db: database(bytes, { mimeType: 'application/pdf' }) as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      operationId,
      createdBy: 'admin-a',
      storage: storage(bytes),
    })

    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'PDF_PARSE_FAILED',
      }),
    )
    expect(recordReceipt.mock.calls[0]?.[0]).not.toHaveProperty('errorMessage')
  })

  it('does not record anything when the immutable object version is unavailable', async () => {
    const bytes = Buffer.from('Safe text', 'utf8')
    await expect(
      executeIntakeFileExtraction({
        db: database(bytes) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        operationId,
        createdBy: 'admin-a',
        storage: {
          send: vi.fn(async () => {
            throw new Error('offline')
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    expect(recordReceipt).not.toHaveBeenCalled()
  })

  it('rejects unsupported and oversized sources before storage access', async () => {
    const bytes = Buffer.from('Safe text', 'utf8')
    const transport = storage(bytes)
    await expect(
      executeIntakeFileExtraction({
        db: database(bytes, { mimeType: 'image/jpeg' }) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        operationId,
        createdBy: 'admin-a',
        storage: transport,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE' })
    await expect(
      executeIntakeFileExtraction({
        db: database(bytes, { byteSize: 2 * 1024 * 1024 + 1 }) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        operationId,
        createdBy: 'admin-a',
        storage: transport,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    await expect(
      executeIntakeFileExtraction({
        db: database(bytes, {
          mimeType: 'application/pdf',
          byteSize: 10 * 1024 * 1024 + 1,
        }) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        operationId,
        createdBy: 'admin-a',
        storage: transport,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
    expect(transport.send).not.toHaveBeenCalled()
    expect(recordReceipt).not.toHaveBeenCalled()
  })

  it('fails closed without a receipt when exact size or hash changes', async () => {
    const verified = Buffer.from('Verified text', 'utf8')
    const changed = Buffer.from('Changed text!', 'utf8')
    await expect(
      executeIntakeFileExtraction({
        db: database(verified) as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        operationId,
        createdBy: 'admin-a',
        storage: storage(changed),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(recordReceipt).not.toHaveBeenCalled()
  })
})
