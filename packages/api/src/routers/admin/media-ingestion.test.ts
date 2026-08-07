import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  beginMediaUpload: vi.fn(),
  enqueueMediaIngestion: vi.fn(),
  finishMediaUpload: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdateMany: vi.fn(),
  signMediaUploadPart: vi.fn(),
  writeAuditLog: vi.fn(),
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

vi.mock('../../lib/media-storage', () => ({
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
    mocks.finishMediaUpload.mockResolvedValue(undefined)
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

  it('completes storage and enqueues the exact scoped project', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({
        id: 'project_1',
        sourceObjectKey: 'staging/tenant/venue/project.zip',
      })
      .mockResolvedValueOnce({ venueId: 'venue_1' })

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
    )
    expect(mocks.enqueueMediaIngestion).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      projectId: 'project_1',
    })
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce()
  })

  it('marks the project FAILED instead of stranding QUEUED when enqueue fails', async () => {
    mocks.projectFindFirst
      .mockResolvedValueOnce({
        id: 'project_1',
        sourceObjectKey: 'staging/tenant/venue/project.zip',
      })
      .mockResolvedValueOnce({ venueId: 'venue_1' })
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
})
