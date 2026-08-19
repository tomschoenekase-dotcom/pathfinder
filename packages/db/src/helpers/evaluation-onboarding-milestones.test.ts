import { describe, expect, it, vi } from 'vitest'

import { recordApprovedPackageEvaluationMilestones } from './evaluation-onboarding-milestones'

const scope = {
  runId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  runIdentityHash: 'a'.repeat(64),
}

function client(runOverrides: Record<string, unknown> = {}) {
  const create = vi.fn(async ({ data }) => data)
  return {
    evalRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: scope.runId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        identityHash: scope.runIdentityHash,
        contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1',
        status: 'COMPLETED',
        startedAt: new Date('2026-08-18T01:00:00.000Z'),
        completedAt: new Date('2026-08-18T01:01:00.000Z'),
        ...runOverrides,
      }),
    },
    evalResult: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'result_1', outcome: 'SCORED', passed: true, evalCase: { category: 'safety' } },
        {
          id: 'result_2',
          outcome: 'OPERATIONAL_FAILURE',
          passed: null,
          evalCase: { category: 'navigation' },
        },
      ]),
    },
    onboardingMilestoneEvent: { findFirst: vi.fn().mockResolvedValue(null), create },
  }
}

describe('approved package evaluation onboarding milestones', () => {
  it('records one honest QA outcome per exact terminal result', async () => {
    const db = client()
    await expect(recordApprovedPackageEvaluationMilestones(scope, db)).resolves.toEqual({
      eligible: true,
      recorded: 2,
    })
    expect(db.onboardingMilestoneEvent.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ category: 'SAFETY:PASSED', durationMs: 60_000 }),
      }),
    )
    expect(db.onboardingMilestoneEvent.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ category: 'NAVIGATION:FAILED' }) }),
    )
  })

  it('does not classify an unrelated evaluation run as onboarding QA', async () => {
    const db = client({ contentSnapshotKind: 'LEGACY_VENUE_CONTENT_V1' })
    await expect(recordApprovedPackageEvaluationMilestones(scope, db)).resolves.toEqual({
      eligible: false,
      recorded: 0,
    })
    expect(db.evalResult.findMany).not.toHaveBeenCalled()
  })

  it('records terminal execution failure without fabricating a QA judgment', async () => {
    const db = client({ status: 'FAILED' })
    db.evalResult.findMany.mockResolvedValue([])
    await recordApprovedPackageEvaluationMilestones(scope, db)
    expect(db.onboardingMilestoneEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'PROCESSING_FAILED',
          category: 'EVALUATION_FAILED',
        }),
      }),
    )
  })
})
