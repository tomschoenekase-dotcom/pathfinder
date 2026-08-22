import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  findMany: vi.fn(),
  enqueue: vi.fn(),
}))

vi.mock('@pathfinder/api/intake-upload-verification', () => ({
  processIntakeUploadAuthoritativeVerification: mocks.process,
}))
vi.mock('@pathfinder/db', () => ({
  db: { intakeUpload: { findMany: mocks.findMany } },
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueIntakeUploadVerification: mocks.enqueue,
}))

import {
  processIntakeUploadVerificationJob,
  reconcileIntakeUploadVerificationJobs,
} from './intake-upload-verification'

describe('intake upload authoritative verification worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.process.mockResolvedValue({ state: 'AWAITING_REVIEW' })
    mocks.findMany.mockResolvedValue([])
    mocks.enqueue.mockResolvedValue(undefined)
  })

  it('uses deterministic system lineage and durable identity only', async () => {
    const payload = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      uploadId: 'upload-a',
      observedUpdatedAt: '2026-08-22T12:00:00.000Z',
    }
    await processIntakeUploadVerificationJob(payload, 'job-a')
    const call = mocks.process.mock.calls[0]?.[0]
    expect(call).toMatchObject({
      ...payload,
      actor: {
        type: 'SYSTEM',
        role: 'SYSTEM',
        actorId: 'intake-upload-verification:job-a',
        systemJobId: 'intake-upload-verification:job-a',
        capability: 'intake-upload.authoritative-verify',
        idempotencyKey: 'job-a',
      },
    })
    expect(call.claimId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    await processIntakeUploadVerificationJob(payload, 'job-a')
    expect(mocks.process.mock.calls[1]?.[0].claimId).toBe(call.claimId)
  })

  it('re-enqueues a bounded set of prechecked or lease-expired uploads', async () => {
    const updatedAt = new Date('2026-08-22T12:00:00.000Z')
    mocks.findMany.mockResolvedValue([
      { tenantId: 'tenant-a', venueId: 'venue-a', id: 'upload-a', updatedAt },
    ])
    await expect(reconcileIntakeUploadVerificationJobs(updatedAt)).resolves.toEqual({
      discovered: 1,
    })
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: expect.objectContaining({ storageVersionId: { not: null } }),
      }),
    )
    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      uploadId: 'upload-a',
      observedUpdatedAt: updatedAt.toISOString(),
    })
  })
})
