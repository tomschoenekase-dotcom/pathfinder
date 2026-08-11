import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  runFindMany: vi.fn(),
  resultGroupBy: vi.fn(),
  reviewFindMany: vi.fn(),
  caseFindMany: vi.fn(),
  createSnapshot: vi.fn(),
  createRun: vi.fn(),
  featureEnabled: vi.fn(),
  enqueueRun: vi.fn(),
}))

vi.mock('@pathfinder/ai', () => ({
  AI_MODEL_KEYS: { GUEST_CHAT: 'guest-chat' },
  getAiModelSpec: () => ({ provider: 'anthropic', model: 'frozen-model', maxOutputTokens: 512 }),
}))

vi.mock('@pathfinder/jobs', () => ({ enqueueEvaluationRun: mocks.enqueueRun }))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  createVenueContentSnapshot: mocks.createSnapshot,
  createOrReplayEvaluationRun: mocks.createRun,
  db: {
    $transaction: vi.fn(async (operation) =>
      operation({
        evalCase: { findMany: mocks.caseFindMany },
        tenantFeatureFlag: { findUnique: mocks.featureEnabled },
      }),
    ),
    evalRun: { findMany: mocks.runFindMany },
    evalResult: { groupBy: mocks.resultGroupBy },
    evalReview: { findMany: mocks.reviewFindMany },
    evalCase: { findMany: mocks.caseFindMany },
    tenantFeatureFlag: { findUnique: mocks.featureEnabled },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminEvaluationOperationsRouter } from './evaluation-operations'

const testRouter = router({ evaluations: adminEvaluationOperationsRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: 'tenant_other',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin evaluation operations router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runFindMany.mockResolvedValue([])
    mocks.featureEnabled.mockResolvedValue(null)
    mocks.enqueueRun.mockResolvedValue({ enqueued: false })
  })

  it('freezes server-derived identities and remains default-off', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    mocks.caseFindMany.mockResolvedValue([{ id: caseId, revision: 2, caseHash: 'b'.repeat(64) }])
    mocks.createSnapshot.mockResolvedValue({
      schemaVersion: 'pathfinder-venue-content-snapshot-v1',
      hash: 'c'.repeat(64),
      contentVersion: 9n,
      componentCounts: {
        venue: 1,
        places: 2,
        knowledgeEntries: 1,
        operationalUpdates: 0,
        universalRevisions: 3,
      },
    })
    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'd'.repeat(64) },
      replayed: false,
      identity,
    }))

    const result = await testRouter.createCaller(context()).evaluations.requestEvaluationRun({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      idempotencyKey: 'operator-request-1',
      caseIds: [caseId],
      budgetCeilingE8Usd: '1000',
    })

    expect(mocks.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    )
    expect(mocks.caseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1', id: { in: [caseId] } },
      }),
    )
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          contentSnapshotHash: 'c'.repeat(64),
          contentSnapshotVersion: 9n,
          caseManifest: [{ caseId, revision: 2, caseHash: 'b'.repeat(64) }],
          modelName: 'frozen-model',
        }),
      }),
    )
    expect(mocks.enqueueRun).toHaveBeenCalledWith(expect.anything(), { enabled: false })
    expect(result).toMatchObject({ enqueued: false, executionDefaultOff: true })
  })

  it('lists only safe scoped case fields with dark readiness and pagination', async () => {
    const createdAt = new Date('2026-08-11T12:00:00Z')
    mocks.caseFindMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        caseKey: 'known',
        revision: 1,
        category: 'known-answer',
        schemaVersion: 'v1',
        sourceType: 'CURATED',
        createdAt,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        caseKey: 'other',
        revision: 1,
        category: 'unknown-answer',
        schemaVersion: 'v1',
        sourceType: 'CURATED',
        createdAt,
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .evaluations.listEvaluationCases({ tenantId: 'tenant_1', venueId: 'venue_1', limit: 1 })
    expect(result).toMatchObject({
      runnerEnabled: false,
      maximumCases: 50,
      maximumBudgetE8Usd: '100000000',
      items: [{ caseKey: 'known' }],
    })
    expect(mocks.caseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
        take: 2,
        select: expect.not.objectContaining({
          caseSnapshot: expect.anything(),
          caseHash: expect.anything(),
        }),
      }),
    )
  })

  it('rejects more than 50 requested cases before any scoped write work', async () => {
    const ids = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    )
    await expect(
      testRouter.createCaller(context()).evaluations.requestEvaluationRun({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        idempotencyKey: 'too-many',
        caseIds: ids,
        budgetCeilingE8Usd: '1',
      }),
    ).rejects.toBeTruthy()
    expect(mocks.createRun).not.toHaveBeenCalled()
  })

  it('rejects non-admin users before the tenant isolation bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).evaluations.listEvaluationRuns({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.runFindMany).not.toHaveBeenCalled()
  })

  it('requires tenant and venue scope, safe selects, and stable pagination', async () => {
    const createdAt = new Date('2026-08-11T12:00:00.000Z')
    mocks.runFindMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', createdAt },
      { id: '22222222-2222-4222-8222-222222222222', createdAt },
    ])
    mocks.resultGroupBy.mockResolvedValue([])
    mocks.reviewFindMany.mockResolvedValue([])

    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      limit: 1,
    })

    expect(result.nextCursor).toEqual({
      createdAt: createdAt.toISOString(),
      id: '11111111-1111-4111-8111-111111111111',
    })
    expect(mocks.runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
        select: expect.not.objectContaining({
          identitySnapshot: expect.anything(),
          modelSnapshot: expect.anything(),
          runConfigSnapshot: expect.anything(),
          caseManifestSnapshot: expect.anything(),
        }),
      }),
    )
    expect(mocks.resultGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          runId: { in: ['11111111-1111-4111-8111-111111111111'] },
        },
      }),
    )
  })

  it('keeps quality failures distinct from operational outcomes and returns conclusions', async () => {
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-08-11T12:00:00.000Z'),
    }
    mocks.runFindMany.mockResolvedValue([run])
    mocks.resultGroupBy.mockResolvedValue([
      { runId: run.id, outcome: 'SCORED', passed: true, _count: { _all: 7 } },
      { runId: run.id, outcome: 'SCORED', passed: false, _count: { _all: 2 } },
      { runId: run.id, outcome: 'OPERATIONAL_FAILURE', passed: null, _count: { _all: 3 } },
      { runId: run.id, outcome: 'BUDGET_BLOCKED', passed: null, _count: { _all: 1 } },
    ])
    mocks.reviewFindMany.mockResolvedValue([{ id: 'review_1', conclusion: 'Needs source fix.' }])

    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })

    expect(result.items[0]?.summary).toEqual({
      resultCount: 13,
      quality: { scored: 9, passed: 7, failed: 2 },
      operational: { failures: 3, deferred: 0, budgetBlocked: 1, cancelled: 0 },
    })
    expect(result.humanConclusions).toEqual([{ id: 'review_1', conclusion: 'Needs source fix.' }])
  })

  it('does not issue secondary queries for an empty run page', async () => {
    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })

    expect(result).toEqual({ items: [], humanConclusions: [], nextCursor: null })
    expect(mocks.resultGroupBy).not.toHaveBeenCalled()
    expect(mocks.reviewFindMany).not.toHaveBeenCalled()
  })
})
