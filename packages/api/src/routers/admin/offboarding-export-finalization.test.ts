import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../../core'
import { adminOffboardingExportFinalizationRouter } from './offboarding-export-finalization'

const findFirst = vi.fn()
const testRouter = router({ admin: adminOffboardingExportFinalizationRouter })

function context(platformAdmin = true) {
  return {
    headers: new Headers(),
    session: {
      userId: 'admin-1',
      activeTenantId: 'tenant-session',
      role: 'OWNER',
      isPlatformAdmin: platformAdmin,
    },
    db: { offboardingPlan: { findFirst } },
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('offboarding export finalization safe projection', () => {
  it('authorizes before reading plan evidence', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.getOffboardingExportFinalization({
        tenantId: 'tenant-1',
        planId: 'plan-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('derives review action and exact remaining matrix without sensitive evidence', async () => {
    findFirst.mockResolvedValue({
      id: 'plan-1',
      status: 'REQUESTED',
      updatedAt: new Date('2026-08-12T10:00:00.000Z'),
      exportKinds: ['CONFIGURATION', 'AUDIT_HISTORY'],
      venueTargets: [
        { venueId: 'venue-1', exportArtifacts: [] },
        { venueId: 'venue-2', exportArtifacts: [{ kind: 'CONFIGURATION' }] },
      ],
    })
    const result = await testRouter
      .createCaller(context())
      .admin.getOffboardingExportFinalization({ tenantId: 'tenant-1', planId: 'plan-1' })
    expect(result).toMatchObject({
      expectedUpdatedAt: '2026-08-12T10:00:00.000Z',
      remainingArtifacts: 3,
      exportActions: { review: { allowed: true }, finalize: { allowed: false } },
      targets: [
        { venueId: 'venue-1', remainingExportKinds: ['CONFIGURATION', 'AUDIT_HISTORY'] },
        { venueId: 'venue-2', remainingExportKinds: ['AUDIT_HISTORY'] },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(
      /artifactReference|contentHash|canonical|objectKey|storedVersion|requestedBy|actor/iu,
    )
  })

  it('enables finalize only for reviewed plans with remaining artifacts', async () => {
    findFirst.mockResolvedValue({
      id: 'plan-1',
      status: 'REVIEWED',
      updatedAt: new Date(),
      exportKinds: ['CONFIGURATION'],
      venueTargets: [{ venueId: 'venue-1', exportArtifacts: [] }],
    })
    await expect(
      testRouter
        .createCaller(context())
        .admin.getOffboardingExportFinalization({ tenantId: 'tenant-1', planId: 'plan-1' }),
    ).resolves.toMatchObject({
      remainingArtifacts: 1,
      exportActions: { review: { allowed: false }, finalize: { allowed: true } },
    })
  })

  it.each(['EXPORT_READY', 'CANCELLED'])('fails both actions closed for %s', async (status) => {
    findFirst.mockResolvedValue({
      id: 'plan-1',
      status,
      updatedAt: new Date(),
      exportKinds: ['CONFIGURATION'],
      venueTargets: [{ venueId: 'venue-1', exportArtifacts: [{ kind: 'CONFIGURATION' }] }],
    })
    await expect(
      testRouter
        .createCaller(context())
        .admin.getOffboardingExportFinalization({ tenantId: 'tenant-1', planId: 'plan-1' }),
    ).resolves.toMatchObject({
      remainingArtifacts: 0,
      exportActions: { review: { allowed: false }, finalize: { allowed: false } },
    })
  })

  it('fails closed for unsupported execution states', async () => {
    findFirst.mockResolvedValue({
      id: 'plan-1',
      status: 'COMPLETED',
      updatedAt: new Date(),
      exportKinds: [],
      venueTargets: [],
    })
    await expect(
      testRouter
        .createCaller(context())
        .admin.getOffboardingExportFinalization({ tenantId: 'tenant-1', planId: 'plan-1' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
