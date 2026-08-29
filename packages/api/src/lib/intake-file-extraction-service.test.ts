import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordIntakeFileExtractionReceiptAction } from '@pathfinder/db'

import { executeIntakeFileExtraction } from './intake-file-extraction-service'

vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  return { ...actual, recordIntakeFileExtractionReceiptAction: vi.fn() }
})

const recordReceipt = vi.mocked(recordIntakeFileExtractionReceiptAction)
const operationId = '568c2e1a-8ece-47ad-98dc-e4bde64872ca'

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
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
        db: database(bytes, { mimeType: 'application/pdf' }) as never,
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
