import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  listIntakeUploadsAction: mocks.list,
  getIntakeUploadDetailAction: mocks.detail,
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminIntakeUploadReviewRouter } from './intake-upload-review'

const now = new Date('2026-08-11T12:00:00.000Z')
const row = {
  id: 'upload-1',
  status: 'AWAITING_REVIEW',
  displayName: 'Guide',
  fileName: 'guide.pdf',
  mimeType: 'application/pdf',
  byteSize: 42,
  rejectionCode: null,
  intakeRunId: 'run-1',
  createdAt: now,
  updatedAt: now,
  verifiedAt: now,
  rejectedAt: null,
  objectKey: 'secret-key',
  objectGeneration: 'secret-generation',
  sha256: 'ab'.repeat(32),
  requestId: 'secret-request',
  rawError: 'secret-error',
  bytes: 'secret-bytes',
  presignedUrl: 'secret-url',
}

function context(admin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin: admin },
  }
}
const caller = router({ admin: adminIntakeUploadReviewRouter })

describe('platform intake upload review metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue({ items: [row], nextCursor: null })
    mocks.detail.mockResolvedValue(row)
  })

  it('authorizes a platform admin before domain access', async () => {
    await expect(
      caller
        .createCaller(context(false))
        .admin.listIntakeUploads({ tenantId: 'tenant-a', venueId: 'venue-a' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('passes exact tenant and venue scope and bounds the list', async () => {
    await caller
      .createCaller(context())
      .admin.listIntakeUploads({ tenantId: 'tenant-a', venueId: 'venue-a', limit: 50 })
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a', limit: 50 }),
    )
    await expect(
      caller
        .createCaller(context())
        .admin.listIntakeUploads({ tenantId: 'tenant-a', venueId: 'venue-a', limit: 51 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('projects review metadata without storage identity, checksum, URLs, bytes, or errors', async () => {
    const result = await caller.createCaller(context()).admin.getIntakeUploadDetail({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      uploadId: 'upload-1',
    })
    expect(mocks.detail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        uploadId: 'upload-1',
      }),
    )
    const serialized = JSON.stringify(result)
    for (const secret of [
      'secret-key',
      'secret-generation',
      'secret-request',
      'secret-error',
      'secret-bytes',
      'secret-url',
      'abababab',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(result).toMatchObject({
      id: 'upload-1',
      status: 'AWAITING_REVIEW',
      intakeRunId: 'run-1',
    })
  })

  it('surfaces queued verification without leaking worker internals', async () => {
    mocks.detail.mockResolvedValue({
      ...row,
      status: 'PRECHECK_PASSED',
      intakeRunId: null,
      verificationLeaseActive: false,
    })
    const result = await caller.createCaller(context()).admin.getIntakeUploadDetail({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      uploadId: 'upload-1',
    })
    expect(result).toMatchObject({
      verificationOperation: 'QUEUED',
      operatorActionRequired: false,
    })
    expect(JSON.stringify(result)).not.toMatch(/claim|storageVersion|clamav/iu)
  })
})
