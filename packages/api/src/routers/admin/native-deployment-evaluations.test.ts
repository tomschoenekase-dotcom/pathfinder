import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../../core'
import type { TRPCContext } from '../../context'

const action = vi.hoisted(() => vi.fn())
const request = vi.hoisted(() => vi.fn())
const compareShadow = vi.hoisted(() => vi.fn())
const measureConvergence = vi.hoisted(() => vi.fn())
const runReads = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }))
const releaseReads = vi.hoisted(() => ({ findFirst: vi.fn() }))
const evidenceReads = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  db: {
    evalRun: runReads,
    nativeVenueDeploymentRelease: releaseReads,
    nativeVenueDeploymentEvaluationEvidence: evidenceReads,
  },
  withTenantIsolationBypass: (fn: () => unknown) => fn(),
  recordNativeDeploymentEvaluationEvidenceAction: action,
  compareNativeContentShadowRuns: compareShadow,
  measureNativeContentConvergenceAction: measureConvergence,
}))
vi.mock('./native-deployment-evaluation-request', async (original) => ({
  ...(await original<typeof import('./native-deployment-evaluation-request')>()),
  requestNativeDeploymentEvaluation: request,
}))

import { adminNativeDeploymentEvaluationsRouter } from './native-deployment-evaluations'

const app = router({ admin: adminNativeDeploymentEvaluationsRouter })
const context = (isPlatformAdmin = true): TRPCContext => ({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin },
})

describe('native deployment evaluation evidence admin adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runReads.findFirst.mockResolvedValue({ identityHash: 'a'.repeat(64) })
    measureConvergence.mockResolvedValue({
      phase: 'NATIVE_HEAD_IN_SYNC',
      head: { releaseId: '11111111-1111-4111-8111-111111111111' },
    })
  })
  it('lists only bounded safe completed legacy and exact-release candidate identities', async () => {
    releaseReads.findFirst.mockResolvedValue({ id: 'release-1' })
    runReads.findMany
      .mockResolvedValueOnce([
        {
          id: 'legacy-run',
          contentSnapshotKind: 'LEGACY_VENUE_CONTENT_V1',
          createdAt: new Date(0),
          completedAt: new Date(1),
          modelProvider: 'openai',
          modelName: 'gpt-safe',
          identityHash: 'must-not-render',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'native-run',
          contentSnapshotKind: 'NATIVE_CORE_V1',
          createdAt: new Date(2),
          completedAt: new Date(3),
          modelProvider: 'openai',
          modelName: 'gpt-safe',
          runConfigSnapshot: { must: 'not render' },
        },
      ])
    const result = await app.createCaller(context()).admin.listNativeContentShadowRuns({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
    })
    expect(result).toMatchObject({
      baselines: [{ id: 'legacy-run' }],
      candidates: [{ id: 'native-run' }],
      bounded: true,
      advisoryOnly: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/identityHash|runConfigSnapshot|contentSnapshot/iu)
    expect(runReads.findMany).toHaveBeenCalledTimes(2)
    expect(runReads.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
        take: 50,
      }),
    )
  })

  it('delegates an exact read-only shadow comparison and preserves non-authorizing boundaries', async () => {
    compareShadow.mockResolvedValue({
      status: 'COMPARABLE_WITH_DECLARED_CHANGE',
      totals: { newFailures: 0, missingResults: 0 },
      advisoryOnly: true,
      guestReadPathChanged: false,
      cutoverAuthorized: false,
      legacyRetirementAuthorized: false,
    })
    const input = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      baselineRunId: '22222222-2222-4222-8222-222222222222',
      candidateRunId: '33333333-3333-4333-8333-333333333333',
    }
    await expect(
      app.createCaller(context()).admin.compareNativeContentShadowRuns(input),
    ).resolves.toMatchObject({
      advisoryOnly: true,
      guestReadPathChanged: false,
      cutoverAuthorized: false,
      readSwitchContract: {
        phase: 'POLICY_GATED',
        executable: false,
        readyForProductionSwitch: false,
        rollback: { compatibilityDataRetentionRequired: true },
      },
    })
    expect(compareShadow).toHaveBeenCalledWith(input, expect.anything())
    expect(measureConvergence).toHaveBeenCalledWith(expect.anything(), input)
  })
  it('delegates exact scope and returns only safe advisory facts', async () => {
    action.mockResolvedValue({ disposition: 'PASS', advisoryOnly: true, replayed: false })
    const input = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      operationId: '33333333-3333-4333-8333-333333333333',
    }
    await expect(
      app.createCaller(context()).admin.recordNativeVenueDeploymentEvaluationEvidence(input),
    ).resolves.toEqual({ disposition: 'PASS', advisoryOnly: true, replayed: false })
    expect(action).toHaveBeenCalledWith(
      {
        ...input,
        expectedRunIdentityHash: 'a'.repeat(64),
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
      },
      expect.anything(),
    )
    expect(JSON.stringify(input)).not.toContain('Hash')
  })
  it('authorizes before the action', async () => {
    await expect(
      app.createCaller(context(false)).admin.recordNativeVenueDeploymentEvaluationEvidence({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId: '11111111-1111-4111-8111-111111111111',
        runId: '22222222-2222-4222-8222-222222222222',
        operationId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(action).not.toHaveBeenCalled()
  })

  it('requests a native run with release CAS and returns no digest or provider fields', async () => {
    request.mockResolvedValue({
      runId: 'run-1',
      status: 'STAGED',
      replayed: false,
      advisoryOnly: true,
    })
    const result = await app.createCaller(context()).admin.requestNativeVenueDeploymentEvaluation({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      expectedReleaseUpdatedAt: new Date('2026-08-12T12:00:00.000Z'),
      operationId: '33333333-3333-4333-8333-333333333333',
      caseIds: ['44444444-4444-4444-8444-444444444444'],
      budgetCeilingE8Usd: '100',
    })
    expect(result).toEqual({
      runId: 'run-1',
      status: 'STAGED',
      replayed: false,
      advisoryOnly: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/hash|provider|model|contentSnapshot/iu)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ budgetCeilingE8Usd: 100n, actorId: 'admin-1' }),
    )
  })

  it('returns an exact safe keyset evidence page', async () => {
    releaseReads.findFirst.mockResolvedValue({ id: 'release-1' })
    evidenceReads.findMany.mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        runId: '22222222-2222-4222-8222-222222222222',
        disposition: 'PASS',
        manifestCaseCount: 1,
        scoredCaseCount: 1,
        passedCaseCount: 1,
        failedCaseCount: 0,
        operationalFailureCount: 0,
        totalLatencyMs: 2,
        totalCostE8Usd: 3n,
        runCompletedAt: new Date(0),
        createdAt: new Date(1),
      },
    ])
    const result = await app
      .createCaller(context())
      .admin.listNativeVenueDeploymentEvaluationEvidence({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId: '11111111-1111-4111-8111-111111111111',
        limit: 10,
      })
    expect(result.items[0]).toMatchObject({
      disposition: 'PASS',
      totalCostE8Usd: '3',
      advisoryOnly: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/identityHash|manifestHash|desiredStateHash|actor/iu)
  })
})
