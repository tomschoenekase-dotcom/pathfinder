import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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
  beginMediaUpload: mocks.beginMediaUpload,
  finishMediaUpload: mocks.finishMediaUpload,
  signMediaUploadPart: mocks.signMediaUploadPart,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIngestionRouter } from './media-ingestion'

const testRouter = router({ mediaIngestion: mediaIngestionRouter })

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
        filename: 'visit.zip',
        bytes: 10,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow('storage unavailable')
    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'project_1', tenantId: 'tenant_1', status: 'UPLOADING' },
      data: { status: 'FAILED', stage: 'upload', error: 'storage unavailable' },
    })
  })

  it('refuses to sign a part beyond the declared upload size', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: BigInt(16 * 1024 * 1024 + 1),
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.signPart({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
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
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
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
    })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).resolves.toEqual({ ok: true })

    expect(mocks.finishMediaUpload).toHaveBeenCalledWith(
      'staging/tenant/venue/project.zip',
      'upload_1',
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
      },
      data: { stage: 'finalizing', error: null },
    })
    expect(mocks.projectUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
      },
      data: {
        status: 'QUEUED',
        stage: 'inventory',
        progress: 1,
        sourceBytes: 10n,
      },
    })
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
    })
    expect(mocks.projectFindFirst).toHaveBeenCalledOnce()
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce()
  })

  it('marks the project FAILED instead of stranding QUEUED when enqueue fails', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
    })
    mocks.enqueueMediaIngestion.mockRejectedValueOnce(new Error('redis unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow('redis unavailable')

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'project_1', tenantId: 'tenant_1', status: 'QUEUED' },
      data: { status: 'FAILED', stage: 'queue', error: 'redis unavailable' },
    })
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('does not touch storage when another caller wins the finalization claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
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
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    mocks.finishMediaUpload.mockRejectedValueOnce(new Error('Completed media upload is empty.'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrow(/empty/)

    expect(mocks.projectUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        status: 'UPLOADING',
        stage: 'finalizing',
      },
      data: { status: 'FAILED', stage: 'upload', error: 'Completed media upload is empty.' },
    })
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
  })

  it('does not enqueue when the verified finalization transition loses its claim', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
        parts: [{ partNumber: 1, etag: 'etag_1' }],
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(mocks.finishMediaUpload).toHaveBeenCalledOnce()
    expect(mocks.enqueueMediaIngestion).not.toHaveBeenCalled()
    expect(mocks.writeAuditLog).not.toHaveBeenCalled()
  })

  it('preserves the storage failure and logs finalization compensation failure', async () => {
    mocks.projectFindFirst.mockResolvedValueOnce({
      id: 'project_1',
      venueId: 'venue_1',
      sourceObjectKey: 'staging/tenant/venue/project.zip',
      sourceBytes: 10n,
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
        uploadId: 'upload_1',
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
    })
    mocks.projectUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    mocks.finishMediaUpload.mockRejectedValueOnce(new Error('head unavailable'))

    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.completeUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        uploadId: 'upload_1',
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
})
