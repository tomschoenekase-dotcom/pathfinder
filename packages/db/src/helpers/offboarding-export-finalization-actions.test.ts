import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OffboardingExportFinalizationError,
  reviewOffboardingPlanForExportAction,
} from './offboarding-export-finalization-actions'

const findFirst = vi.fn()
const updateMany = vi.fn()
const auditCreate = vi.fn()
const tx = {
  offboardingPlan: { findFirst, updateMany },
  auditLog: { create: auditCreate },
}
const client = { $transaction: vi.fn((work: (value: unknown) => unknown) => work(tx)) }
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const expectedUpdatedAt = new Date('2026-08-12T10:00:00.000Z')
const operationId = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  auditCreate.mockResolvedValue({ id: 'audit-1' })
  updateMany.mockResolvedValue({ count: 1 })
})

describe('reviewOffboardingPlanForExportAction', () => {
  it('atomically records exact produced review and strict audit evidence', async () => {
    findFirst.mockResolvedValue({
      status: 'REQUESTED',
      updatedAt: expectedUpdatedAt,
      exportKinds: ['CONFIGURATION'],
      exportReviewOperationId: null,
      exportReviewOperationHash: null,
      exportReviewedBy: null,
      exportReviewedAt: null,
      _count: { venueTargets: 1 },
    })
    const result = await reviewOffboardingPlanForExportAction(
      { tenantId: 'tenant-1', planId: 'plan-1', operationId, expectedUpdatedAt, actor },
      client as never,
    )
    expect(result).toMatchObject({ status: 'REVIEWED', replayed: false })
    expect(auditCreate).toHaveBeenCalledBefore(updateMany)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ exportReviewAuditId: 'audit-1' }),
      }),
    )
  })

  it.each(['REVIEWED', 'EXPORT_READY', 'CANCELLED'])(
    'replays the durable review after later %s state',
    async (status) => {
      findFirst.mockResolvedValue({
        status,
        updatedAt: new Date('2026-08-12T11:00:00.000Z'),
        exportKinds: ['CONFIGURATION'],
        exportReviewOperationId: operationId,
        exportReviewOperationHash: expect.anything(),
        exportReviewedBy: actor.id,
        exportReviewedAt: expectedUpdatedAt,
        _count: { venueTargets: 1 },
      })
      // Capture the canonical hash through a first successful call.
      findFirst.mockResolvedValueOnce({
        status: 'REQUESTED',
        updatedAt: expectedUpdatedAt,
        exportKinds: ['CONFIGURATION'],
        exportReviewOperationId: null,
        exportReviewOperationHash: null,
        exportReviewedBy: null,
        exportReviewedAt: null,
        _count: { venueTargets: 1 },
      })
      await reviewOffboardingPlanForExportAction(
        { tenantId: 'tenant-1', planId: 'plan-1', operationId, expectedUpdatedAt, actor },
        client as never,
      )
      const hash = updateMany.mock.calls[0]?.[0].data.exportReviewOperationHash
      findFirst.mockResolvedValue({
        status,
        updatedAt: new Date(),
        exportKinds: ['CONFIGURATION'],
        exportReviewOperationId: operationId,
        exportReviewOperationHash: hash,
        exportReviewedBy: actor.id,
        exportReviewedAt: expectedUpdatedAt,
        _count: { venueTargets: 1 },
      })
      await expect(
        reviewOffboardingPlanForExportAction(
          { tenantId: 'tenant-1', planId: 'plan-1', operationId, expectedUpdatedAt, actor },
          client as never,
        ),
      ).resolves.toMatchObject({ replayed: true, updatedAt: expectedUpdatedAt })
      expect(auditCreate).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects stale or unauthorized review without audit writes', async () => {
    findFirst.mockResolvedValue({
      status: 'REQUESTED',
      updatedAt: new Date(0),
      exportKinds: ['CONFIGURATION'],
      exportReviewOperationId: null,
      _count: { venueTargets: 1 },
    })
    await expect(
      reviewOffboardingPlanForExportAction(
        { tenantId: 'tenant-1', planId: 'plan-1', operationId, expectedUpdatedAt, actor },
        client as never,
      ),
    ).rejects.toBeInstanceOf(OffboardingExportFinalizationError)
    expect(auditCreate).not.toHaveBeenCalled()
  })
})
