import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  abortMediaUpload: vi.fn(),
  assertVenueAvailable: vi.fn(),
  assetFindFirst: vi.fn(),
  assetFindMany: vi.fn(),
  beginMediaUpload: vi.fn(),
  enqueueMediaIngestion: vi.fn(),
  finishMediaUpload: vi.fn(),
  inspectCompletedMediaUpload: vi.fn(),
  listReusableMediaUploadParts: vi.fn(),
  loggerWarn: vi.fn(),
  projectFindFirst: vi.fn(),
  projectFindMany: vi.fn(),
  projectUpdateMany: vi.fn(),
  signMediaUploadPart: vi.fn(),
  writeAuditLog: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn },
}))

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  assertVenueAvailable: mocks.assertVenueAvailable,
  db: {
    mediaIngestionProject: {
      findFirst: mocks.projectFindFirst,
      findMany: mocks.projectFindMany,
      updateMany: mocks.projectUpdateMany,
    },
    mediaIngestionAsset: {
      findFirst: mocks.assetFindFirst,
      findMany: mocks.assetFindMany,
    },
  },
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
  writeAuditLog: mocks.writeAuditLog,
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueMediaIngestion: mocks.enqueueMediaIngestion,
}))

vi.mock('../../lib/media-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/media-storage')>()),
  abortMediaUpload: mocks.abortMediaUpload,
  beginMediaUpload: mocks.beginMediaUpload,
  finishMediaUpload: mocks.finishMediaUpload,
  inspectCompletedMediaUpload: mocks.inspectCompletedMediaUpload,
  listReusableMediaUploadParts: mocks.listReusableMediaUploadParts,
  signMediaUploadPart: mocks.signMediaUploadPart,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { MediaUploadCompletionUnconfirmedError } from '../../lib/media-storage'
import { mediaIngestionRouter } from './media-ingestion'

const testRouter = router({ mediaIngestion: mediaIngestionRouter })
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222'
const UPPER_ATTEMPT_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
const CANONICAL_UPPER_ATTEMPT_ID = UPPER_ATTEMPT_ID.toLowerCase()
const SOURCE_IDENTITY = {
  algorithm: 'pathfinder-sha256-part-manifest-v1' as const,
  digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}
const ABANDONED_UPLOAD_STARTED_AT = new Date('2026-07-01T00:00:00.000Z')
const ABANDONED_UPLOAD_CUTOFF = new Date('2026-07-02T00:00:00.000Z')

function serializeCalls(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))
}

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'user_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('media ingestion router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.abortMediaUpload.mockResolvedValue(undefined)
    mocks.assertVenueAvailable.mockResolvedValue(undefined)
    mocks.beginMediaUpload.mockResolvedValue({
      uploadId: 'storage_upload_1',
      partSize: 16 * 1024 * 1024,
    })
    mocks.finishMediaUpload.mockResolvedValue({ bytes: 10 })
    mocks.inspectCompletedMediaUpload.mockResolvedValue({ state: 'missing' })
    mocks.listReusableMediaUploadParts.mockResolvedValue([
      { partNumber: 1, etag: 'etag_1', size: 10 },
    ])
    mocks.projectFindMany.mockResolvedValue([])
    mocks.assetFindFirst.mockResolvedValue(null)
    mocks.assetFindMany.mockResolvedValue([])
    mocks.enqueueMediaIngestion.mockResolvedValue(undefined)
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 })
    mocks.writeAuditLog.mockResolvedValue(undefined)
  })

  it('returns only current-generation source evidence without exposing storage identity', async () => {
    const updatedAt = new Date('2026-08-08T18:00:00.000Z')
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      name: 'Visit',
      context: '',
      mode: 'BALANCED',
      status: 'READY_FOR_REVIEW',
      stage: 'review',
      progress: 100,
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 123n,
      sourceFingerprintAlgorithm: 'pathfinder-sha256-part-manifest-v1',
      uploadAttemptId: null,
      settings: {},
      coverage: {},
      questions: [],
      findings: Array.from({ length: 51 }, (_, index) => ({
        sourceId: `S-${index + 1}`,
        filename: `${index + 1}.jpg`,
        mediaType: 'IMAGE',
        summary: `Finding ${index + 1}`,
        uncertainties: [],
      })),
      draftJson: { schemaVersion: 1, places: [], knowledgeEntries: [] },
      estimatedCostCents: null,
      actualCostCents: 0,
      error: null,
      createdAt: updatedAt,
      updatedAt,
      completedAt: updatedAt,
      sourceObjectKey: 'tenant/venue/project/generation/archive.zip',
      sourceObjectGeneration: ATTEMPT_ID,
    })
    mocks.assetFindMany.mockResolvedValueOnce([
      {
        id: 'asset_1',
        sourceId: 'S-1',
        filename: 'one.jpg',
        mediaType: 'IMAGE',
        bytes: 10n,
        status: 'COMPLETE',
        analysis: { summary: 'One' },
        error: null,
        updatedAt,
      },
    ])

    const result = await testRouter.createCaller(context(true)).mediaIngestion.get({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
    })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          projectId: 'project_1',
          objectKey: { startsWith: 'tenant/venue/project/generation/archive.zip#' },
        }),
        take: 51,
      }),
    )
    expect(result.assets).toEqual([expect.objectContaining({ id: 'asset_1', bytes: 10 })])
    expect(result.findings).toHaveLength(50)
    expect(result.findingsNextCursor).toBe('S-50')
    expect(serializeCalls(result)).not.toContain('Finding 51')
    expect(serializeCalls(result)).not.toContain('sourceObjectKey')
    expect(serializeCalls(result)).not.toContain('archive.zip#')
  })

  it('paginates source evidence only for the exact review generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectKey: 'tenant/venue/project/generation/archive.zip',
      sourceObjectGeneration: ATTEMPT_ID,
    })
    mocks.assetFindFirst.mockResolvedValueOnce({
      id: 'cm00000000000000000000001',
      filename: 'one.jpg',
    })
    mocks.assetFindMany.mockResolvedValueOnce([
      {
        id: 'asset_2',
        sourceId: 'S-2',
        filename: 'two.jpg',
        mediaType: 'IMAGE',
        bytes: 20n,
        status: 'COMPLETE',
        analysis: {},
        error: null,
        updatedAt: new Date(),
      },
      {
        id: 'asset_3',
        sourceId: 'S-3',
        filename: 'three.jpg',
        mediaType: 'IMAGE',
        bytes: 30n,
        status: 'COMPLETE',
        analysis: {},
        error: null,
        updatedAt: new Date(),
      },
    ])

    const result = await testRouter.createCaller(context(true)).mediaIngestion.listAssets({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      reviewGeneration: ATTEMPT_ID,
      cursor: 'cm00000000000000000000001',
      limit: 1,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: 'asset_2', bytes: 20 })
    expect(result.nextCursor).toBe('asset_2')
    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          projectId: 'project_1',
          objectKey: { startsWith: 'tenant/venue/project/generation/archive.zip#' },
          OR: [
            { filename: { gt: 'one.jpg' } },
            { filename: 'one.jpg', id: { gt: 'cm00000000000000000000001' } },
          ],
        }),
        take: 2,
      }),
    )
  })

  it('rejects a source evidence cursor outside the fenced project generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectKey: 'tenant/venue/project/generation/archive.zip',
      sourceObjectGeneration: ATTEMPT_ID,
    })

    await expect(
      testRouter.createCaller(context(true)).mediaIngestion.listAssets({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        projectId: 'project_1',
        reviewGeneration: ATTEMPT_ID,
        cursor: 'cm00000000000000000000001',
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.assetFindMany).not.toHaveBeenCalled()
  })

  it('preserves generated evidence and questions while saving fenced reviewer patches', async () => {
    const expectedUpdatedAt = new Date('2026-08-08T18:00:00.000Z')
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectGeneration: ATTEMPT_ID,
      questions: [{ id: 'Q-1', question: 'Accessible?' }],
      findings: [
        {
          sourceId: 'S-1',
          filename: 'one.jpg',
          mediaType: 'IMAGE',
          summary: 'Original summary',
          uncertainties: ['Original uncertainty'],
        },
      ],
    })

    const result = await testRouter.createCaller(context(true)).mediaIngestion.saveReview({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      reviewGeneration: ATTEMPT_ID,
      expectedUpdatedAt,
      questionAnswers: [{ id: 'Q-1', answer: '' }],
      findingCorrections: [
        {
          sourceId: 'S-1',
          summary: 'Corrected summary',
          uncertainties: [],
          note: 'Checked against the source.',
        },
      ],
      draftJson: {
        schemaVersion: 1,
        places: [{ name: 'North Hall', type: 'exhibit', tags: [], importanceScore: 50 }],
        knowledgeEntries: [],
      },
    })

    expect(result).toMatchObject({
      ok: true,
      updatedAt: expect.any(Date),
      status: 'NEEDS_INPUT',
      questions: [{ id: 'Q-1', question: 'Accessible?', answer: '' }],
      findingReviews: [
        expect.objectContaining({
          sourceId: 'S-1',
          review: expect.objectContaining({ summary: 'Corrected summary' }),
        }),
      ],
    })
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'project_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          sourceObjectGeneration: ATTEMPT_ID,
          updatedAt: expectedUpdatedAt,
        }),
        data: expect.objectContaining({
          status: 'NEEDS_INPUT',
          stage: 'questions',
          questions: [{ id: 'Q-1', question: 'Accessible?', answer: '' }],
          findings: [
            expect.objectContaining({
              summary: 'Original summary',
              review: expect.objectContaining({
                summary: 'Corrected summary',
                reviewedBy: 'user_1',
              }),
            }),
          ],
          updatedAt: result.updatedAt,
        }),
      }),
    )
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce()
  })

  it('paginates editable findings without returning the full project payload', async () => {
    const findings = Array.from({ length: 51 }, (_, index) => ({
      sourceId: `S-${index + 1}`,
      filename: `${String(index + 1).padStart(2, '0')}.jpg`,
      mediaType: 'IMAGE',
      summary: `Finding ${index + 1}`,
      uncertainties: [],
    }))
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectGeneration: ATTEMPT_ID,
      findings,
    })

    const result = await testRouter.createCaller(context(true)).mediaIngestion.listFindings({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      reviewGeneration: ATTEMPT_ID,
    })

    expect(result.items).toHaveLength(50)
    expect(result.items[0]).toMatchObject({ sourceId: 'S-1' })
    expect(result.nextCursor).toBe('S-50')
    expect(serializeCalls(result)).not.toContain('Finding 51')
  })

  it('rejects a stale review save without writing an audit success', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectGeneration: ATTEMPT_ID,
      questions: [],
      findings: [],
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      testRouter.createCaller(context(true)).mediaIngestion.saveReview({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        projectId: 'project_1',
        reviewGeneration: ATTEMPT_ID,
        expectedUpdatedAt: new Date('2026-08-08T18:00:00.000Z'),
        questionAnswers: [],
        findingCorrections: [],
        draftJson: {
          schemaVersion: 1,
          places: [{ name: 'North Hall', type: 'exhibit' }],
          knowledgeEntries: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('rejects all access for non-platform admins', async () => {
    const caller = testRouter.createCaller(context(false))
    await expect(
      caller.mediaIngestion.list({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })

  it('rejects archives larger than 5 GB before touching storage', async () => {
    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 5 * 1024 * 1024 * 1024 + 1,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow()
  })

  it('cannot overwrite a concurrent worker claim after reading FAILED', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'FAILED',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
  })

  it('compensates the upload reservation when storage creation fails', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.beginMediaUpload.mockRejectedValueOnce(new Error('storage unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('storage unavailable')
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: {
        status: 'FAILED',
        stage: 'upload',
        error: 'storage unavailable',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
      },
    })
  })

  it('preserves the storage creation failure when its compensation write rejects', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
    mocks.beginMediaUpload.mockRejectedValueOnce(new Error('storage unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('storage unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-creation-compensation.failed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'database unavailable',
    })
  })

  it('preserves the storage creation failure when its compensation claim is lost', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.beginMediaUpload.mockRejectedValueOnce(new Error('storage unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('storage unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-creation-compensation.missed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
  })

  it('persists the server upload ID behind the attempt-scoped creation claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: UPPER_ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        lastModified: 123456,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({ partSize: 16 * 1024 * 1024, parts: [] })

    expect(mocks.beginMediaUpload).toHaveBeenCalledWith(
      `staging/media-ingestion/tenant_1/venue_1/project_1/${CANONICAL_UPPER_ATTEMPT_ID}/visit.zip`,
      'application/zip',
      CANONICAL_UPPER_ATTEMPT_ID,
    )
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: { in: ['DRAFT', 'FAILED'] },
      },
      data: expect.objectContaining({
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: CANONICAL_UPPER_ATTEMPT_ID,
        storageUploadId: null,
        sourceObjectGeneration: CANONICAL_UPPER_ATTEMPT_ID,
        sourceObjectKey: `staging/media-ingestion/tenant_1/venue_1/project_1/${CANONICAL_UPPER_ATTEMPT_ID}/visit.zip`,
        sourceLastModified: 123456n,
        sourceFingerprintAlgorithm: SOURCE_IDENTITY.algorithm,
        sourceFingerprint: SOURCE_IDENTITY.digest,
        sourceContentType: 'application/zip',
        providerOperationCount: 0,
        uploadStartedAt: expect.any(Date),
      }),
    })
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: CANONICAL_UPPER_ATTEMPT_ID,
      },
      data: { stage: 'upload', storageUploadId: 'storage_upload_1' },
    })
  })

  it('cannot reset a failed generation budget by reusing its upload attempt ID', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'FAILED',
      uploadAttemptId: ATTEMPT_ID,
      providerOperationCount: 10_000,
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
  })

  it('replays the exact persisted begin attempt without creating another storage upload', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 0n,
      sourceFingerprintAlgorithm: SOURCE_IDENTITY.algorithm,
      sourceFingerprint: SOURCE_IDENTITY.digest,
      sourceObjectGeneration: null,
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'server_secret_upload_id',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({
      partSize: 16 * 1024 * 1024,
      parts: [{ partNumber: 1, etag: 'etag_1', size: 10 }],
    })

    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects a changed or omitted fingerprint before listing reusable parts', async () => {
    const persisted = {
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 0n,
      sourceFingerprintAlgorithm: SOURCE_IDENTITY.algorithm,
      sourceFingerprint: SOURCE_IDENTITY.digest,
      sourceObjectGeneration: ATTEMPT_ID,
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'server_secret_upload_id',
    }
    mocks.projectFindFirst.mockResolvedValue(persisted)
    const caller = testRouter.createCaller(context(true))

    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: { ...SOURCE_IDENTITY, digest: 'b'.repeat(64) },
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(mocks.listReusableMediaUploadParts).not.toHaveBeenCalled()
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
  })

  it('keeps legacy null-fingerprint uploads resumable without adopting a digest', async () => {
    mocks.projectFindFirst.mockResolvedValue({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 0n,
      sourceFingerprintAlgorithm: null,
      sourceFingerprint: null,
      sourceObjectGeneration: ATTEMPT_ID,
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'server_secret_upload_id',
    })
    const caller = testRouter.createCaller(context(true))

    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({
      partSize: 16 * 1024 * 1024,
      parts: [{ partNumber: 1, etag: 'etag_1', size: 10 }],
    })

    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
  })

  it('requires a strong fingerprint before reserving a new upload', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
      stage: 'setup',
    })
    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
  })

  it('rejects non-canonical source digests before database access', async () => {
    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: { ...SOURCE_IDENTITY, digest: 'A'.repeat(64) },
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow()
    expect(mocks.projectFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a resume selection with a different browser file identity', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 123456n,
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'server_secret_upload_id',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        lastModified: 123457,
        contentType: 'application/zip',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))

    expect(mocks.listReusableMediaUploadParts).not.toHaveBeenCalled()
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
  })

  it('reports an expired storage upload as a recoverable conflict', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
      sourceLastModified: 0n,
      sourceFingerprintAlgorithm: SOURCE_IDENTITY.algorithm,
      sourceFingerprint: SOURCE_IDENTITY.digest,
      sourceObjectGeneration: null,
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'expired_storage_upload',
    })
    mocks.listReusableMediaUploadParts.mockRejectedValueOnce(
      Object.assign(new Error('storage detail'), { name: 'NoSuchUpload' }),
    )

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'CONFLICT',
        message: 'This multipart upload expired. Abort it and start again.',
      }),
    )

    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
  })

  it('accepts an exact readback when persistence committed but its response was lost', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1', status: 'DRAFT' })
      .mockResolvedValueOnce({ stage: 'upload', storageUploadId: 'storage_upload_1' })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('persistence response lost'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({ partSize: 16 * 1024 * 1024, parts: [] })

    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectFindFirst).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { stage: true, storageUploadId: true },
    })
  })

  it('preserves uncertain identity state when persistence readback is unavailable', async () => {
    const persistenceError = new Error('persistence response lost')
    mocks.projectFindFirst
      .mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1', status: 'DRAFT' })
      .mockRejectedValueOnce(new Error('readback database unavailable'))
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(persistenceError)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('persistence response lost')

    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-identity-persistence.uncertain',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload identity persistence could not be confirmed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('storage_upload_1')
  })

  it('preserves uncertain identity state when readback has advanced beyond upload', async () => {
    const persistenceError = new Error('persistence response lost')
    mocks.projectFindFirst
      .mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1', status: 'DRAFT' })
      .mockResolvedValueOnce({ stage: 'finalizing', storageUploadId: 'storage_upload_1' })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(persistenceError)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('persistence response lost')

    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-identity-persistence.uncertain',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload identity persistence could not be confirmed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('storage_upload_1')
  })

  it('does not abort or compensate after a thrown persistence write without positive readback', async () => {
    const persistenceError = new Error(
      'Unique constraint failed on storage_upload_id storage_upload_1',
    )
    mocks.projectFindFirst
      .mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1', status: 'DRAFT' })
      .mockResolvedValueOnce({ stage: 'creating-upload', storageUploadId: null })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(persistenceError)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('Unique constraint failed')

    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-identity-persistence.uncertain',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload identity persistence could not be confirmed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('storage_upload_1')
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('Unique constraint failed')
  })

  it('rejects reuse of an attempt ID with different upload metadata', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'other.zip',
      sourceBytes: 10n,
      sourceContentType: 'application/zip',
      uploadAttemptId: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.beginMediaUpload).not.toHaveBeenCalled()
  })

  it('aborts the newly-created storage upload when persistence loses its CAS claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/claim was lost/)

    expect(mocks.abortMediaUpload).toHaveBeenCalledWith(
      expect.stringContaining(
        `/media-ingestion/tenant_1/venue_1/project_1/${ATTEMPT_ID}/visit.zip`,
      ),
      'storage_upload_1',
    )
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: expect.objectContaining({
        status: 'FAILED',
        error: 'Upload identity persistence failed.',
        uploadAttemptId: null,
        storageUploadId: null,
      }),
    })
    expect(serializeCalls(mocks.projectUpdateMany.mock.calls)).not.toContain(
      'The media upload generation claim was lost before persistence.',
    )
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('storage_upload_1')
  })

  it('logs abort failure but preserves the upload persistence error', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    mocks.abortMediaUpload.mockRejectedValueOnce(new Error('abort unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/claim was lost/)
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-creation-abort.failed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Newly created multipart upload abort failed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('abort unavailable')
  })

  it('preserves a lost identity claim when its compensation write rejects', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error('database unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/claim was lost/)
    expect(mocks.abortMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-identity-compensation.failed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload identity compensation failed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('database unavailable')
  })

  it('preserves a lost identity claim when its compensation claim is also lost', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'DRAFT',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        sourceIdentity: SOURCE_IDENTITY,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/claim was lost/)
    expect(mocks.abortMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-identity-compensation.missed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
  })

  it('uses only the persisted storage upload ID when signing parts', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'server_storage_upload',
    })
    mocks.signMediaUploadPart.mockResolvedValueOnce('https://signed.example/part')

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.signPart({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        partNumber: 1,
      }),
    ).resolves.toEqual({ url: 'https://signed.example/part' })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { sourceObjectKey: true, sourceBytes: true, storageUploadId: true },
    })
    expect(mocks.signMediaUploadPart).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'server_storage_upload',
      1,
    )
  })

  it('refuses to sign a part beyond the declared upload size', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: BigInt(16 * 1024 * 1024 + 1),
      storageUploadId: 'storage_upload_1',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.signPart({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        partNumber: 3,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(mocks.signMediaUploadPart).not.toHaveBeenCalled()
  })

  it('rejects an incomplete part set before claiming completion or touching storage', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: BigInt(16 * 1024 * 1024 + 1),
      storageUploadId: 'storage_upload_1',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
  })

  it('rejects stale client ETags before claiming completion', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.listReusableMediaUploadParts.mockResolvedValueOnce([
      { partNumber: 1, etag: 'storage_etag', size: 10 },
    ])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'stale_etag' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
  })

  it('completes storage and enqueues the exact scoped project', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.finishMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'storage_upload_1',
      [{ partNumber: 1, etag: 'etag_1' }],
      10,
      5 * 1024 * 1024 * 1024,
      undefined,
    )
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { stage: 'finalizing', error: null },
    })
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: {
        status: 'QUEUED',
        stage: 'inventory',
        progress: 1,
        sourceBytes: 10n,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceContentType: null,
      },
    })
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
    expect(mocks.projectFindFirst).toHaveBeenCalledOnce()
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce()
  })

  it('leaves the exact generation QUEUED for retry when enqueue fails', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.enqueueMediaIngestion.mockRejectedValueOnce(new Error('redis unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow('redis unavailable')

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'QUEUED',
        stage: 'inventory',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { error: 'Media ingestion enqueue could not be confirmed.' },
    })
    expect(serializeCalls(mocks.projectUpdateMany.mock.calls)).not.toContain('redis unavailable')
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('does not touch storage when another caller wins the finalization claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('marks only its finalization claim failed when verification rejects', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.finishMediaUpload.mockRejectedValueOnce(new Error('Completed media upload is empty.'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow(/empty/)

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { status: 'FAILED', stage: 'upload', error: 'Completed media upload is empty.' },
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('retains finalizing state when completion cannot be confirmed', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.finishMediaUpload.mockRejectedValueOnce(
      new MediaUploadCompletionUnconfirmedError(new Error('response lost')),
    )

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { error: 'Media upload finalization needs confirmation.' },
    })
    expect(serializeCalls(mocks.projectUpdateMany.mock.calls)).not.toContain('response lost')
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('reconciles an exact completed object and queues the same generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.inspectCompletedMediaUpload.mockResolvedValueOnce({
      state: 'verified',
      bytes: 10,
      versionId: undefined,
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.inspectCompletedMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      10,
      5 * 1024 * 1024 * 1024,
      ATTEMPT_ID,
    )
    expect(mocks.listReusableMediaUploadParts).not.toHaveBeenCalled()
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
  })

  it('fails closed when reconciliation finds a different object generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.inspectCompletedMediaUpload.mockResolvedValueOnce({ state: 'identity-mismatch' })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: {
        status: 'FAILED',
        stage: 'completion-unverified',
        error: 'Media upload completion evidence was invalid.',
      },
    })
    expect(mocks.listReusableMediaUploadParts).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('restores upload state when reconciliation finds incomplete reusable parts', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.inspectCompletedMediaUpload.mockResolvedValueOnce({ state: 'missing' })
    mocks.listReusableMediaUploadParts.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true, state: 'upload' })

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: {
        stage: 'upload',
        error: 'Some upload parts must be sent again before finalization.',
      },
    })
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('retries completion with server ETags when all multipart parts still exist', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.inspectCompletedMediaUpload.mockResolvedValueOnce({ state: 'missing' })
    mocks.listReusableMediaUploadParts.mockResolvedValueOnce([
      { partNumber: 1, etag: 'server_etag', size: 10 },
    ])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.finishMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'storage_upload_1',
      [{ partNumber: 1, etag: 'server_etag' }],
      10,
      5 * 1024 * 1024 * 1024,
      ATTEMPT_ID,
    )
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledOnce()
  })

  it('does not infer completion from NoSuchUpload during reconciliation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: ATTEMPT_ID,
      storageUploadId: 'storage_upload_1',
    })
    mocks.inspectCompletedMediaUpload.mockResolvedValueOnce({ state: 'missing' })
    mocks.listReusableMediaUploadParts.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
    )

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))

    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { error: 'Media upload finalization needs confirmation.' },
    })
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('never adopts an unbound legacy object but can retry its active multipart upload', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      sourceObjectGeneration: null,
      storageUploadId: 'storage_upload_1',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.inspectCompletedMediaUpload).not.toHaveBeenCalled()
    expect(mocks.finishMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'storage_upload_1',
      [{ partNumber: 1, etag: 'etag_1' }],
      10,
      5 * 1024 * 1024 * 1024,
      undefined,
    )
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledOnce()
  })

  it('does not inspect storage for a different tenant or upload attempt', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.reconcileUpload({
        tenantId: 'tenant_2',
        projectId: 'project_1',
        uploadAttemptId: OTHER_ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(mocks.inspectCompletedMediaUpload).not.toHaveBeenCalled()
    expect(mocks.listReusableMediaUploadParts).not.toHaveBeenCalled()
    expect(mocks.finishMediaUpload).not.toHaveBeenCalled()
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('does not enqueue when the verified finalization transition loses its claim', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({
        id: 'project_1',
        venueId: 'venue_1',
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        sourceBytes: 10n,
        storageUploadId: 'storage_upload_1',
      })
      .mockResolvedValueOnce(null)
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.finishMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('enqueues after an ambiguous transition only when exact QUEUED state is read back', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({
        id: 'project_1',
        venueId: 'venue_1',
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        sourceBytes: 10n,
        storageUploadId: 'storage_upload_1',
      })
      .mockResolvedValueOnce({ status: 'QUEUED', stage: 'inventory', sourceBytes: 10n })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('transaction response unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.projectFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { status: true, stage: true, sourceBytes: true },
    })
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
  })

  it('does not enqueue when ambiguous transition readback has different verified bytes', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({
        id: 'project_1',
        venueId: 'venue_1',
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        sourceBytes: 10n,
        storageUploadId: 'storage_upload_1',
      })
      .mockResolvedValueOnce({ status: 'QUEUED', stage: 'inventory', sourceBytes: 9n })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('transaction response unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow('transaction response unavailable')

    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-queue-transition.uncertain',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload queue transition could not be confirmed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain(
      'transaction response unavailable',
    )
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('storage_upload_1')
  })

  it('retries enqueue only for the exact queued upload generation', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1' })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.retryEnqueue({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: UPPER_ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'QUEUED',
        stage: 'inventory',
        uploadAttemptId: CANONICAL_UPPER_ATTEMPT_ID,
      },
      select: { id: true, venueId: true },
    })
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: CANONICAL_UPPER_ATTEMPT_ID,
    })
  })

  it('rejects retry enqueue for a different upload attempt', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.retryEnqueue({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: OTHER_ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'QUEUED',
        stage: 'inventory',
        uploadAttemptId: OTHER_ATTEMPT_ID,
      },
      select: { id: true, venueId: true },
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('rejects retry enqueue while the project venue is unavailable', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({ id: 'project_1', venueId: 'venue_1' })
    mocks.assertVenueAvailable.mockRejectedValueOnce(new Error('venue unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.retryEnqueue({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    expect(mocks.assertVenueAvailable).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('preserves the storage failure and logs finalization compensation failure', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
    const storageError = new Error('head unavailable')
    mocks.finishMediaUpload.mockRejectedValueOnce(storageError)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow('head unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-finalization-compensation.failed',
      projectId: 'project_1',
      error: 'database unavailable',
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('logs when failed finalization no longer owns the compensation state', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
      storageUploadId: 'storage_upload_1',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.finishMediaUpload.mockRejectedValueOnce(new Error('head unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow('head unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-finalization-compensation.missed',
      projectId: 'project_1',
      error: 'The finalization claim no longer matched.',
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('dry-runs a bounded exact-tenant abandoned upload scan by default', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
    ])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 10,
      }),
    ).resolves.toEqual({
      applied: false,
      truncated: false,
      candidates: [
        {
          projectId: 'project_1',
          uploadAttemptId: ATTEMPT_ID,
          uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
          stage: 'upload',
        },
      ],
      results: [],
    })

    expect(mocks.projectFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: { in: ['upload', 'aborting'] },
        uploadAttemptId: { not: null },
        uploadStartedAt: { not: null, lte: ABANDONED_UPLOAD_CUTOFF },
        sourceObjectKey: { not: null },
        storageUploadId: { not: null },
      },
      select: {
        id: true,
        stage: true,
        uploadAttemptId: true,
        uploadStartedAt: true,
        sourceObjectKey: true,
        storageUploadId: true,
      },
      orderBy: [{ uploadStartedAt: 'asc' }, { id: 'asc' }],
      take: 11,
    })
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('reports truncation without acting beyond the requested expiry cap', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
      {
        id: 'project_2',
        stage: 'upload',
        uploadAttemptId: OTHER_ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/other-attempt/archive.zip',
        storageUploadId: 'storage_upload_2',
      },
    ])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 1,
      }),
    ).resolves.toEqual({
      applied: false,
      truncated: true,
      candidates: [
        {
          projectId: 'project_1',
          uploadAttemptId: ATTEMPT_ID,
          uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
          stage: 'upload',
        },
      ],
      results: [],
    })
    expect(mocks.projectFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
    expect(mocks.projectUpdateMany).not.toHaveBeenCalled()
    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
  })

  it('expires only the exact abandoned upload generation and audits terminal success', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
    ])

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 10,
        dryRun: false,
      }),
    ).resolves.toEqual({
      applied: true,
      truncated: false,
      candidates: [],
      results: [{ projectId: 'project_1', uploadAttemptId: ATTEMPT_ID, outcome: 'cancelled' }],
    })

    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
      data: { stage: 'aborting', error: null },
    })
    expect(mocks.abortMediaUpload).toHaveBeenCalledWith(
      'staging/media/project/attempt/archive.zip',
      'storage_upload_1',
    )
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
        error: null,
      },
    })
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.media_ingestion.upload_expired' }),
    )
  })

  it('skips storage when an abandoned generation changes after discovery', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
    ])
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 1,
        dryRun: false,
      }),
    ).resolves.toEqual({
      applied: true,
      truncated: false,
      candidates: [],
      results: [{ projectId: 'project_1', uploadAttemptId: ATTEMPT_ID, outcome: 'state-changed' }],
    })

    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('keeps a first NoSuchUpload response unconfirmed for a later resumed abort', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
    ])
    mocks.abortMediaUpload.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
    )

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 1,
        dryRun: false,
      }),
    ).resolves.toEqual({
      applied: true,
      truncated: false,
      candidates: [],
      results: [{ projectId: 'project_1', uploadAttemptId: ATTEMPT_ID, outcome: 'unconfirmed' }],
    })

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
      data: { stage: 'aborting', error: 'Media upload abort could not be confirmed.' },
    })
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('finishes a resumed abandoned abort when storage reports it already gone', async () => {
    mocks.projectFindMany.mockResolvedValueOnce([
      {
        id: 'project_1',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
    ])
    mocks.projectFindFirst.mockResolvedValueOnce({ id: 'project_1' })
    mocks.abortMediaUpload.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
    )

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: ABANDONED_UPLOAD_CUTOFF,
        limit: 1,
        dryRun: false,
      }),
    ).resolves.toEqual({
      applied: true,
      truncated: false,
      candidates: [],
      results: [{ projectId: 'project_1', uploadAttemptId: ATTEMPT_ID, outcome: 'cancelled' }],
    })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        uploadStartedAt: ABANDONED_UPLOAD_STARTED_AT,
        sourceObjectKey: 'staging/media/project/attempt/archive.zip',
        storageUploadId: 'storage_upload_1',
      },
      select: { id: true },
    })
    expect(mocks.projectUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.media_ingestion.upload_expired' }),
    )
  })

  it('rejects an expiry cutoff in the future before scanning', async () => {
    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.expireAbandonedUploads({
        tenantId: 'tenant_1',
        before: new Date(Date.now() + 60_000),
        limit: 1,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))

    expect(mocks.projectFindMany).not.toHaveBeenCalled()
    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
  })

  it('claims and aborts only the persisted attempt, then clears its upload capability', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { id: true, sourceObjectKey: true, storageUploadId: true },
    })
    expect(mocks.abortMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'server_storage_upload',
    )
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { stage: 'aborting', error: null },
    })
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        storageUploadId: 'server_storage_upload',
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
        error: null,
      },
    })
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.media_ingestion.upload_aborted',
        targetId: 'project_1',
      }),
    )
  })

  it('finishes a resumed abort when storage reports the multipart upload is already gone', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    const noSuchUpload = Object.assign(new Error('The specified upload does not exist.'), {
      name: 'NoSuchUpload',
    })
    mocks.abortMediaUpload.mockRejectedValueOnce(noSuchUpload)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.projectFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { id: true, sourceObjectKey: true, storageUploadId: true },
    })
    expect(mocks.projectFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { id: true, sourceObjectKey: true, storageUploadId: true },
    })
    expect(mocks.projectUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        storageUploadId: 'server_storage_upload',
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
        sourceObjectGeneration: null,
        sourceContentType: null,
        error: null,
      },
    })
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.media_ingestion.upload_aborted',
        targetId: 'project_1',
      }),
    )
  })

  it('keeps a resumed abort claimed when storage fails for another reason', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.abortMediaUpload.mockRejectedValueOnce(new Error('storage abort unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrow('storage abort unavailable')

    expect(mocks.projectUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.projectUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        storageUploadId: 'server_storage_upload',
      },
      data: { stage: 'aborting', error: 'Media upload abort could not be confirmed.' },
    })
    expect(serializeCalls(mocks.projectUpdateMany.mock.calls)).not.toContain(
      'storage abort unavailable',
    )
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('does not touch storage when another caller wins the abort claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.abortMediaUpload).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('keeps the first abort claimed with a stable error when storage abort fails', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.abortMediaUpload.mockRejectedValueOnce(new Error('storage abort unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrow('storage abort unavailable')
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'aborting',
        uploadAttemptId: ATTEMPT_ID,
        sourceObjectKey: 'staging/tenant/venue/project.zip',
        storageUploadId: 'server_storage_upload',
      },
      data: { stage: 'aborting', error: 'Media upload abort could not be confirmed.' },
    })
    expect(serializeCalls(mocks.projectUpdateMany.mock.calls)).not.toContain(
      'storage abort unavailable',
    )
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('preserves the storage abort failure when its compensation write rejects', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.projectUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
    mocks.abortMediaUpload.mockRejectedValueOnce(new Error('storage abort unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrow('storage abort unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-abort-compensation.failed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
      error: 'Upload abort state persistence failed.',
      errorType: 'Error',
    })
    expect(serializeCalls(mocks.loggerWarn.mock.calls)).not.toContain('database unavailable')
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('preserves the storage abort failure when its compensation claim is lost', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.abortMediaUpload.mockRejectedValueOnce(new Error('storage abort unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrow('storage abort unavailable')
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      action: 'media-ingestion.upload-abort-compensation.missed',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
    })
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('reports a lost cancellation CAS after storage abort without auditing success', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      storageUploadId: 'server_storage_upload',
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.abortUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.abortMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('does not bind a different attempt to an active storage upload', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.signPart({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadAttemptId: OTHER_ATTEMPT_ID,
        partNumber: 1,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(mocks.signMediaUploadPart).not.toHaveBeenCalled()
  })
})
