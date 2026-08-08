import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  abortMediaUpload: vi.fn(),
  beginMediaUpload: vi.fn(),
  enqueueMediaIngestion: vi.fn(),
  finishMediaUpload: vi.fn(),
  loggerWarn: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdateMany: vi.fn(),
  signMediaUploadPart: vi.fn(),
  writeAuditLog: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mocks.loggerWarn },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    mediaIngestionProject: {
      findFirst: mocks.projectFindFirst,
      updateMany: mocks.projectUpdateMany,
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
  signMediaUploadPart: mocks.signMediaUploadPart,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIngestionRouter } from './media-ingestion'

const testRouter = router({ mediaIngestion: mediaIngestionRouter })
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222'

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
    mocks.beginMediaUpload.mockResolvedValue({
      uploadId: 'storage_upload_1',
      partSize: 16 * 1024 * 1024,
    })
    mocks.finishMediaUpload.mockResolvedValue({ bytes: 10 })
    mocks.enqueueMediaIngestion.mockResolvedValue(undefined)
    mocks.projectUpdateMany.mockResolvedValue({ count: 1 })
    mocks.writeAuditLog.mockResolvedValue(undefined)
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
        uploadAttemptId: ATTEMPT_ID,
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({ partSize: 16 * 1024 * 1024 })

    expect(mocks.beginMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: { in: ['DRAFT', 'FAILED'] },
      },
      data: expect.objectContaining({
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: ATTEMPT_ID,
        storageUploadId: null,
        sourceContentType: 'application/zip',
        uploadStartedAt: expect.any(Date),
      }),
    })
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'creating-upload',
        uploadAttemptId: ATTEMPT_ID,
      },
      data: { stage: 'upload', storageUploadId: 'storage_upload_1' },
    })
  })

  it('replays the exact persisted begin attempt without creating another storage upload', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      status: 'UPLOADING',
      stage: 'upload',
      sourceFileName: 'visit.zip',
      sourceBytes: 10n,
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
    ).resolves.toEqual({ partSize: 16 * 1024 * 1024 })

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
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).resolves.toEqual({ partSize: 16 * 1024 * 1024 })

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
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/claim was lost/)

    expect(mocks.abortMediaUpload).toHaveBeenCalledWith(
      expect.stringContaining('/media-ingestion/tenant_1/venue_1/project_1/visit.zip'),
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
        uploadAttemptId: ATTEMPT_ID,
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.projectFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'QUEUED',
        stage: 'inventory',
        uploadAttemptId: ATTEMPT_ID,
      },
      select: { id: true, venueId: true },
    })
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
      uploadAttemptId: ATTEMPT_ID,
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
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
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
      },
      data: {
        status: 'CANCELLED',
        stage: 'cancelled',
        uploadAttemptId: null,
        uploadStartedAt: null,
        storageUploadId: null,
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
