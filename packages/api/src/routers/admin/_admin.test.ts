import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  tenantFindMany,
  tenantFindUnique,
  tenantCreate,
  tenantUpdate,
  weeklyDigestFindUnique,
  weeklyDigestCreate,
  visitorSessionCount,
  visitorSessionFindFirst,
  visitorSessionFindMany,
  visitorSessionUpdateMany,
  messageCount,
  questionClusterFindMany,
  aiUsageDailyRollupFindMany,
  userUpsert,
  tenantMembershipUpsert,
  adminChatlogNoteCreate,
  answerAnalysisSnapshotCreate,
  answerAnalysisSnapshotFindFirst,
  answerAnalysisSnapshotUpdateMany,
  weeklyReportFindUnique,
  weeklyReportCreate,
  weeklyReportUpdate,
  weeklyReportFindFirst,
  weeklyReportUpdateMany,
  venueFindFirst,
  venueCreate,
  venueReportConfigurationFindFirst,
  venueReportConfigurationCreate,
  venueReportConfigurationUpdate,
  generationRequestDispatchFindFirst,
  generationRequestDispatchCreate,
  auditLogCreate,
  dbTransaction,
  writeAuditLogMock,
  writeAuditLogStrictMock,
  enqueueWeeklyDigest,
  enqueueGenerationDispatchKick,
  createOrganizationMock,
  currentUserMock,
  validateExistingOrganizationOwnerMock,
  loggerWarn,
  lockVenueReportMutation,
} = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantCreate: vi.fn(),
  tenantUpdate: vi.fn(),
  weeklyDigestFindUnique: vi.fn(),
  weeklyDigestCreate: vi.fn(),
  visitorSessionCount: vi.fn(),
  visitorSessionFindFirst: vi.fn(),
  visitorSessionFindMany: vi.fn(),
  visitorSessionUpdateMany: vi.fn(),
  messageCount: vi.fn(),
  questionClusterFindMany: vi.fn(),
  aiUsageDailyRollupFindMany: vi.fn(),
  userUpsert: vi.fn(),
  tenantMembershipUpsert: vi.fn(),
  adminChatlogNoteCreate: vi.fn(),
  answerAnalysisSnapshotCreate: vi.fn(),
  answerAnalysisSnapshotFindFirst: vi.fn(),
  answerAnalysisSnapshotUpdateMany: vi.fn(),
  weeklyReportFindUnique: vi.fn(),
  weeklyReportCreate: vi.fn(),
  weeklyReportUpdate: vi.fn(),
  weeklyReportFindFirst: vi.fn(),
  weeklyReportUpdateMany: vi.fn(),
  venueFindFirst: vi.fn(),
  venueCreate: vi.fn(),
  venueReportConfigurationFindFirst: vi.fn(),
  venueReportConfigurationCreate: vi.fn(),
  venueReportConfigurationUpdate: vi.fn(),
  generationRequestDispatchFindFirst: vi.fn(),
  generationRequestDispatchCreate: vi.fn(),
  auditLogCreate: vi.fn(),
  dbTransaction: vi.fn(),
  writeAuditLogMock: vi.fn(),
  writeAuditLogStrictMock: vi.fn(),
  enqueueWeeklyDigest: vi.fn(),
  enqueueGenerationDispatchKick: vi.fn(),
  createOrganizationMock: vi.fn(),
  currentUserMock: vi.fn(),
  validateExistingOrganizationOwnerMock: vi.fn(),
  loggerWarn: vi.fn(),
  lockVenueReportMutation: vi.fn(),
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { warn: loggerWarn },
}))

vi.mock('@pathfinder/db', () => {
  const transactionDb = {
    tenant: {
      findMany: tenantFindMany,
      findUnique: tenantFindUnique,
      create: tenantCreate,
      update: tenantUpdate,
    },
    weeklyDigest: {
      findUnique: weeklyDigestFindUnique,
      create: weeklyDigestCreate,
    },
    visitorSession: {
      count: visitorSessionCount,
      findFirst: visitorSessionFindFirst,
      findMany: visitorSessionFindMany,
      updateMany: visitorSessionUpdateMany,
    },
    message: {
      count: messageCount,
    },
    questionCluster: {
      findMany: questionClusterFindMany,
    },
    aiUsageDailyRollup: {
      findMany: aiUsageDailyRollupFindMany,
    },
    user: {
      upsert: userUpsert,
    },
    tenantMembership: {
      upsert: tenantMembershipUpsert,
    },
    adminChatlogNote: {
      create: adminChatlogNoteCreate,
    },
    answerAnalysisSnapshot: {
      create: answerAnalysisSnapshotCreate,
      findFirst: answerAnalysisSnapshotFindFirst,
      updateMany: answerAnalysisSnapshotUpdateMany,
    },
    weeklyReport: {
      findUnique: weeklyReportFindUnique,
      create: weeklyReportCreate,
      update: weeklyReportUpdate,
      findFirst: weeklyReportFindFirst,
      updateMany: weeklyReportUpdateMany,
    },
    venue: {
      findFirst: venueFindFirst,
      create: venueCreate,
    },
    venueReportConfiguration: {
      findFirst: venueReportConfigurationFindFirst,
      create: venueReportConfigurationCreate,
      update: venueReportConfigurationUpdate,
    },
    generationRequestDispatch: {
      findFirst: generationRequestDispatchFindFirst,
      create: generationRequestDispatchCreate,
    },
    auditLog: { create: auditLogCreate },
  }
  return {
    AI_COST_BUDGET_COVERAGE_VERSION: 'gateway-v1',
    assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
    reconcileExpiredAiCostAttempts: vi.fn().mockResolvedValue({
      scanned: 0,
      settled: 0,
      raced: 0,
    }),
    db: {
      ...transactionDb,
      $transaction: (callback: (transaction: typeof transactionDb) => Promise<unknown>) =>
        dbTransaction(callback, transactionDb),
    },
    writeAuditLog: writeAuditLogMock,
    writeAuditLogStrict: writeAuditLogStrictMock,
    lockVenueReportMutation,
    setContentVersionContext: vi.fn().mockResolvedValue(undefined),
    withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
  }
})

vi.mock('@pathfinder/jobs', () => ({
  enqueueWeeklyDigest,
  enqueueGenerationDispatchKick,
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    createOrganization: createOrganizationMock,
    currentUser: currentUserMock,
    validateExistingOrganizationOwner: validateExistingOrganizationOwnerMock,
  }
})

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { generationRequestHash } from '../../lib/generation-request-identity'
import { adminRouter } from './_admin'

const baseCtx = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
}

function adminCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  }
}

function nonAdminCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ admin: adminRouter })

describe('admin router', () => {
  const reportRevision = new Date('2026-08-08T12:00:00.000Z')

  beforeEach(() => {
    vi.resetAllMocks()
    visitorSessionUpdateMany.mockResolvedValue({ count: 1 })
    answerAnalysisSnapshotUpdateMany.mockResolvedValue({ count: 1 })
    weeklyReportUpdateMany.mockResolvedValue({ count: 1 })
    dbTransaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>, transaction: unknown) =>
        callback(transaction),
    )
    generationRequestDispatchFindFirst.mockResolvedValue(null)
    venueReportConfigurationFindFirst.mockResolvedValue({ enabled: true })
    lockVenueReportMutation.mockResolvedValue(undefined)
    validateExistingOrganizationOwnerMock.mockResolvedValue({
      organizationId: 'org_existing',
      userId: 'user_owner',
      emailAddress: 'Owner@Example.com',
    })
    generationRequestDispatchCreate.mockImplementation(async ({ data }) => ({
      id: data.id,
      recordId: data.recordId,
      requestHash: data.requestHash,
      status: 'PENDING',
    }))
  })

  it('admin.triggerDigest creates a digest for the current week and enqueues it', async () => {
    tenantFindUnique.mockResolvedValueOnce({ id: 'tenant_1' })
    weeklyDigestFindUnique.mockResolvedValueOnce(null)
    weeklyDigestCreate.mockResolvedValueOnce({ id: 'digest_1' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_1' })
    expect(weeklyDigestCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          status: 'PENDING',
        }),
      }),
    )
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_1',
      }),
    )
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.digest.triggered',
        actorId: 'admin_1',
        targetId: 'digest_1',
      }),
    )
  })

  it('admin.triggerDigest reuses the current week digest when one already exists', async () => {
    tenantFindUnique.mockResolvedValueOnce({ id: 'tenant_1' })
    weeklyDigestFindUnique.mockResolvedValueOnce({ id: 'digest_existing' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_existing' })
    expect(weeklyDigestCreate).not.toHaveBeenCalled()
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_existing',
      }),
    )
  })

  it('admin.triggerDigest throws NOT_FOUND when the tenant does not exist', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(caller.admin.triggerDigest({ tenantId: 'missing_tenant' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('admin.triggerDigest throws FORBIDDEN for non-admin users', async () => {
    const caller = testRouter.createCaller(nonAdminCtx())

    await expect(caller.admin.triggerDigest({ tenantId: 'tenant_1' })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }),
    )
  })

  it('admin.getClientAnalytics returns tenant stats, clusters, and recent sessions', async () => {
    const startedAt = new Date('2026-07-01T12:00:00.000Z')
    const messageCreatedAt = new Date('2026-07-01T12:01:00.000Z')
    const windowStart = new Date('2026-06-30T00:00:00.000Z')

    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Tenant One',
      slug: 'tenant-one',
    })
    visitorSessionCount.mockResolvedValueOnce(3)
    messageCount.mockResolvedValueOnce(8)
    visitorSessionFindMany
      .mockResolvedValueOnce([{ visitorId: 'visitor_1' }, { visitorId: 'visitor_2' }])
      .mockResolvedValueOnce([
        {
          id: 'session_1',
          startedAt,
          lastActiveAt: startedAt,
          messageCount: 2,
          visitorId: 'visitor_1',
          messages: [
            {
              id: 'message_1',
              role: 'user',
              content: 'Where are the bathrooms?',
              createdAt: messageCreatedAt,
              topic: 'amenities',
            },
          ],
        },
      ])
    questionClusterFindMany.mockResolvedValueOnce([
      {
        id: 'cluster_1',
        kind: 'top_question',
        canonicalText: 'Where are the bathrooms?',
        count: 4,
        examples: [],
        windowStart,
        venue: { name: 'Main Venue' },
      },
    ])

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.getClientAnalytics({ tenantId: 'tenant_1' })

    expect(result.stats).toEqual({
      totalSessions: 3,
      totalMessages: 8,
      uniqueVisitors: 2,
    })
    expect(result.tenant.name).toBe('Tenant One')
    expect(result.recentSessions).toHaveLength(1)
    expect(result.questionClusters).toHaveLength(1)
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['visitorId'],
      }),
    )
  })

  it('admin.getClientAnalytics throws NOT_FOUND when the tenant does not exist', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    visitorSessionCount.mockResolvedValueOnce(0)
    messageCount.mockResolvedValueOnce(0)
    visitorSessionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    questionClusterFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.getClientAnalytics({ tenantId: 'missing_tenant' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('admin.getClientAiCosts returns exact estimated totals for the tenant UTC window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T19:30:00.000Z'))
    try {
      tenantFindUnique.mockResolvedValueOnce({
        id: 'tenant_1',
        name: 'Tenant One',
        slug: 'tenant-one',
      })
      aiUsageDailyRollupFindMany.mockResolvedValueOnce([
        {
          date: new Date('2026-08-06T00:00:00.000Z'),
          venueId: 'venue_1',
          feature: 'guest-chat',
          requestCount: 2,
          successfulRequestCount: 1,
          failedRequestCount: 1,
          totalTokens: 120,
          estimatedCostUsd: '0.10000001',
          venue: { name: 'Main Venue' },
        },
        {
          date: new Date('2026-08-07T00:00:00.000Z'),
          venueId: 'venue_1',
          feature: 'place-embedding',
          requestCount: 1,
          successfulRequestCount: 1,
          failedRequestCount: 0,
          totalTokens: 5,
          estimatedCostUsd: '2e-8',
          venue: { name: 'Main Venue' },
        },
      ])

      const result = await testRouter
        .createCaller(adminCtx())
        .admin.getClientAiCosts({ tenantId: 'tenant_1', days: 2 })

      expect(aiUsageDailyRollupFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant_1',
            date: {
              gte: new Date('2026-08-06T00:00:00.000Z'),
              lt: new Date('2026-08-08T00:00:00.000Z'),
            },
          },
        }),
      )
      expect(result.totals).toEqual({
        requestCount: 3,
        successfulRequestCount: 2,
        failedRequestCount: 1,
        totalTokens: 125,
        estimatedCostUsd: '0.10000003',
      })
      expect(result.costs.map((row) => row.estimatedCostUsd)).toEqual(['0.10000001', '0.00000002'])
      expect(result.breakdown).toEqual([
        {
          venueId: 'venue_1',
          venueName: 'Main Venue',
          requestCount: 3,
          totalTokens: 125,
          estimatedCostUsd: '0.10000003',
          features: [
            {
              feature: 'guest-chat',
              requestCount: 2,
              totalTokens: 120,
              estimatedCostUsd: '0.10000001',
            },
            {
              feature: 'place-embedding',
              requestCount: 1,
              totalTokens: 5,
              estimatedCostUsd: '0.00000002',
            },
          ],
        },
      ])
      expect(result.completeness).toBe('estimated-lower-bound')
    } finally {
      vi.useRealTimers()
    }
  })

  it('admin.getClientAiCosts has a graceful empty state and remains admin-only', async () => {
    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Tenant One',
      slug: 'tenant-one',
    })
    aiUsageDailyRollupFindMany.mockResolvedValueOnce([])

    const result = await testRouter
      .createCaller(adminCtx())
      .admin.getClientAiCosts({ tenantId: 'tenant_1' })

    expect(result.costs).toEqual([])
    expect(result.breakdown).toEqual([])
    expect(result.totals).toEqual({
      requestCount: 0,
      successfulRequestCount: 0,
      failedRequestCount: 0,
      totalTokens: 0,
      estimatedCostUsd: '0.00000000',
    })

    await expect(
      testRouter.createCaller(nonAdminCtx()).admin.getClientAiCosts({ tenantId: 'tenant_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })

  it('admin.getSessionChatlog binds the detail read to tenant, venue, and session', async () => {
    const session = { id: 'session_1', venueId: 'venue_1' }
    visitorSessionFindFirst.mockResolvedValueOnce(session)

    const result = await testRouter.createCaller(adminCtx()).admin.getSessionChatlog({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
    })

    expect(result).toBe(session)
    expect(visitorSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'session_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        },
      }),
    )
  })

  it('admin.getSessionChatlog returns NOT_FOUND for a same-tenant venue mismatch', async () => {
    visitorSessionFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(adminCtx()).admin.getSessionChatlog({
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
        sessionId: 'session_1',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(visitorSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'session_1',
          tenantId: 'tenant_1',
          venueId: 'wrong_venue',
        },
      }),
    )
  })

  it('admin.setSessionNotable writes an audit log with the correct action for true/false', async () => {
    const caller = testRouter.createCaller(adminCtx())

    await caller.admin.setSessionNotable({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      isNotable: true,
    })
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.chatlog.marked_notable', targetId: 'session_1' }),
    )

    await caller.admin.setSessionNotable({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      isNotable: false,
    })
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.chatlog.unmarked_notable', targetId: 'session_1' }),
    )
  })

  it('admin.setSessionNotable rejects a tenant/session mismatch without auditing', async () => {
    visitorSessionUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.setSessionNotable({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'other_tenant_session',
        isNotable: true,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(visitorSessionUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'other_tenant_session',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      },
      data: { isNotable: true },
    })
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.addChatlogNote sources authorId from the admin session, not client input', async () => {
    visitorSessionFindFirst.mockResolvedValueOnce({ id: 'session_1' })
    adminChatlogNoteCreate.mockResolvedValueOnce({
      id: 'note_1',
      note: 'Guest was confused about wait times.',
      authorId: 'admin_1',
      createdAt: new Date(),
    })

    const caller = testRouter.createCaller(adminCtx())
    await caller.admin.addChatlogNote({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      note: 'Guest was confused about wait times.',
    })

    expect(adminChatlogNoteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorId: 'admin_1' }),
      }),
    )
    expect(visitorSessionFindFirst).toHaveBeenCalledWith({
      where: { id: 'session_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      select: { id: true },
    })
  })

  it('admin.addChatlogNote rejects a composite session mismatch before create or audit', async () => {
    visitorSessionFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.addChatlogNote({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'other_tenant_session',
        note: 'Must not cross the ownership boundary.',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(visitorSessionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'other_tenant_session',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      },
      select: { id: true },
    })
    expect(adminChatlogNoteCreate).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.generateAnswerAnalysis atomically creates domain, dispatch, and audit', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateAnswerAnalysis({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: '2026-07-01T00:00:00.000Z',
      rangeEnd: '2026-07-31T23:59:59.999Z',
      requestId: '11111111-1111-4111-8111-111111111111',
    })

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(answerAnalysisSnapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          createdBy: 'admin_1',
        }),
      }),
    )
    expect(generationRequestDispatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          kind: 'ANSWER_ANALYSIS',
          requestId: '11111111-1111-4111-8111-111111111111',
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          answerAnalysisSnapshotId: expect.any(String),
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.answer_analysis.requested',
          targetId: result.snapshotId,
        }),
      }),
    )
    expect(enqueueGenerationDispatchKick).toHaveBeenCalledWith(expect.any(String))
    expect(result).toEqual({
      snapshotId: expect.any(String),
      requestId: '11111111-1111-4111-8111-111111111111',
      dispatchState: 'PENDING',
      replayed: false,
    })
  })

  it('admin.generateAnswerAnalysis preserves durable success when the best-effort kick fails', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    enqueueGenerationDispatchKick.mockRejectedValueOnce(
      new Error('redis://private-host queue unavailable'),
    )

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateAnswerAnalysis({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: '2026-07-01T00:00:00.000Z',
      rangeEnd: '2026-07-31T23:59:59.999Z',
      requestId: '22222222-2222-4222-8222-222222222222',
    })

    expect(result).toEqual({
      snapshotId: expect.any(String),
      requestId: '22222222-2222-4222-8222-222222222222',
      dispatchState: 'PENDING',
      replayed: false,
    })
    expect(answerAnalysisSnapshotUpdateMany).not.toHaveBeenCalled()
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.answer-analysis.dispatch-kick.failed',
        error: 'Durable analysis request is pending dispatcher retry.',
      }),
    )
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('private-host')
  })

  it('admin.generateAnswerAnalysis replays an exact request without duplicate writes', async () => {
    generationRequestDispatchFindFirst.mockResolvedValueOnce({
      id: 'dispatch_existing',
      recordId: 'snapshot_existing',
      requestHash: generationRequestHash({
        kind: 'ANSWER_ANALYSIS',
        venueId: 'venue_1',
        rangeStart: new Date('2026-07-01T00:00:00.000Z'),
        rangeEnd: new Date('2026-07-31T23:59:59.999Z'),
      }),
      status: 'PENDING',
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateAnswerAnalysis({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: '2026-07-01T00:00:00.000Z',
      rangeEnd: '2026-07-31T23:59:59.999Z',
      requestId: '33333333-3333-4333-8333-333333333333',
    })

    expect(result).toEqual({
      snapshotId: 'snapshot_existing',
      requestId: '33333333-3333-4333-8333-333333333333',
      dispatchState: 'PENDING',
      replayed: true,
    })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(answerAnalysisSnapshotCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).toHaveBeenCalledWith('dispatch_existing')
  })

  it('admin.generateAnswerAnalysis rejects reuse of a request ID for changed input', async () => {
    generationRequestDispatchFindFirst.mockResolvedValueOnce({
      id: 'dispatch_existing',
      recordId: 'snapshot_existing',
      requestHash: '0'.repeat(64),
      status: 'PENDING',
    })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.generateAnswerAnalysis({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        rangeStart: '2026-07-01T00:00:00.000Z',
        rangeEnd: '2026-07-31T23:59:59.999Z',
        requestId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Request ID was already used for different analysis input.',
    })

    expect(answerAnalysisSnapshotCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.generateAnswerAnalysis rejects a venue mismatch before create or enqueue', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.generateAnswerAnalysis({
        tenantId: 'tenant_1',
        venueId: 'other_tenant_venue',
        rangeStart: '2026-07-01T00:00:00.000Z',
        rangeEnd: '2026-07-31T23:59:59.999Z',
        requestId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'other_tenant_venue', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(answerAnalysisSnapshotCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.getAnswerAnalysis binds the detail read to tenant, venue, and snapshot', async () => {
    const snapshot = { id: 'snapshot_1', venueId: 'venue_1', status: 'COMPLETE' }
    answerAnalysisSnapshotFindFirst.mockResolvedValueOnce(snapshot)

    const result = await testRouter.createCaller(adminCtx()).admin.getAnswerAnalysis({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      snapshotId: 'snapshot_1',
    })

    expect(result).toBe(snapshot)
    expect(answerAnalysisSnapshotFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      },
    })
  })

  it('admin.getAnswerAnalysis returns NOT_FOUND for a same-tenant venue mismatch', async () => {
    answerAnalysisSnapshotFindFirst.mockResolvedValueOnce(null)

    await expect(
      testRouter.createCaller(adminCtx()).admin.getAnswerAnalysis({
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
        snapshotId: 'snapshot_1',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(answerAnalysisSnapshotFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
      },
    })
  })

  it('admin.createClient validates Clerk identity before atomically creating the tenant owner', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    tenantCreate.mockResolvedValueOnce({ id: 'org_existing' })

    const result = await testRouter.createCaller(adminCtx()).admin.createClient({
      orgId: 'org_existing',
      name: 'Existing Organization',
      slug: 'existing-organization',
      userId: 'user_owner',
      userEmail: 'owner@example.com',
    })

    expect(validateExistingOrganizationOwnerMock).toHaveBeenCalledWith({
      organizationId: 'org_existing',
      userId: 'user_owner',
      emailAddress: 'owner@example.com',
    })
    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(tenantCreate).toHaveBeenCalledWith({
      data: {
        id: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
      },
    })
    expect(userUpsert).toHaveBeenCalledWith({
      where: { id: 'user_owner' },
      create: { id: 'user_owner', email: 'Owner@Example.com' },
      update: { email: 'Owner@Example.com' },
    })
    expect(tenantMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'org_existing',
          userId: 'user_owner',
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      }),
    )
    expect(writeAuditLogStrictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.client.created',
        targetId: 'org_existing',
        afterState: expect.objectContaining({ ownerUserId: 'user_owner' }),
      }),
      expect.objectContaining({ tenant: expect.any(Object), auditLog: expect.any(Object) }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('admin.createClient performs no database work when Clerk identity validation fails', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    validateExistingOrganizationOwnerMock.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Clerk identity rejected' }),
    )

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_missing',
        name: 'Missing Organization',
        slug: 'missing-organization',
        userId: 'user_missing',
        userEmail: 'missing@example.com',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    expect(tenantFindUnique).toHaveBeenCalledOnce()
    expect(dbTransaction).not.toHaveBeenCalled()
    expect(tenantCreate).not.toHaveBeenCalled()
    expect(userUpsert).not.toHaveBeenCalled()
    expect(tenantMembershipUpsert).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.createClient fails the transaction when its strict audit cannot be written', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    writeAuditLogStrictMock.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toThrow('audit unavailable')

    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(writeAuditLogStrictMock).toHaveBeenCalledOnce()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.createClient does not mutate when the validated Clerk org already exists locally', async () => {
    tenantFindUnique.mockResolvedValueOnce({ id: 'org_existing' })

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(dbTransaction).not.toHaveBeenCalled()
    expect(tenantCreate).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
    expect(validateExistingOrganizationOwnerMock).not.toHaveBeenCalled()
  })

  it('admin.createClient maps a concurrent unique create race to CONFLICT', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    tenantCreate.mockRejectedValueOnce({ code: 'P2002' })

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A client with this organization ID or slug already exists',
    })

    expect(validateExistingOrganizationOwnerMock).toHaveBeenCalledOnce()
    expect(writeAuditLogStrictMock).not.toHaveBeenCalled()
  })

  it('admin.createClient does not mislabel a local user identity conflict as a client race', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    tenantCreate.mockResolvedValueOnce({ id: 'org_existing' })
    userUpsert.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['email'] } })

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })

    expect(writeAuditLogStrictMock).not.toHaveBeenCalled()
  })

  it('admin.createClientAndVenue creates the org, tenant, admin membership, and venue', async () => {
    createOrganizationMock.mockResolvedValueOnce({
      id: 'org_new',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    tenantFindUnique.mockResolvedValueOnce(null) // slug uniqueness check
    tenantCreate.mockResolvedValueOnce({
      id: 'org_new',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    venueFindFirst.mockResolvedValueOnce(null) // venue slug uniqueness check
    venueCreate.mockResolvedValueOnce({ id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.createClientAndVenue({
      clientName: 'The Grand Hotel',
      venue: { name: 'Main Lobby' },
    })

    expect(createOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'The Grand Hotel', createdByUserId: 'admin_1' }),
    )
    expect(tenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      }),
    )
    expect(tenantMembershipUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'org_new',
          userId: 'admin_1',
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      }),
    )
    expect(venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'org_new', name: 'Main Lobby' }),
      }),
    )
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.client.created', targetId: 'org_new' }),
    )
    expect(result).toEqual({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
    })
  })

  it('admin.createClientAndVenue throws FORBIDDEN for non-admin users', async () => {
    const caller = testRouter.createCaller(nonAdminCtx())

    await expect(
      caller.admin.createClientAndVenue({
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(createOrganizationMock).not.toHaveBeenCalled()
  })

  it('admin.generateWeeklyReportDraft atomically creates domain, dispatch, and audit', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateWeeklyReportDraft({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: '2026-07-01T00:00:00.000Z',
      weekEnd: '2026-07-15T23:59:59.999Z',
      title: 'My custom report title',
      requestId: '66666666-6666-4666-8666-666666666666',
    })

    expect(result).toEqual({
      reportId: expect.any(String),
      requestId: '66666666-6666-4666-8666-666666666666',
      dispatchState: 'PENDING',
      replayed: false,
    })
    expect(weeklyReportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'GENERATING',
          title: 'My custom report title',
        }),
      }),
    )
    expect(generationRequestDispatchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          kind: 'WEEKLY_REPORT',
          requestId: '66666666-6666-4666-8666-666666666666',
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          weeklyReportId: expect.any(String),
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.report.requested',
          targetId: result.reportId,
        }),
      }),
    )
    expect(enqueueGenerationDispatchKick).toHaveBeenCalledWith(expect.any(String))
  })

  it('admin.generateWeeklyReportDraft fails closed before writes when reports are disabled', async () => {
    venueReportConfigurationFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.generateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        weekStart: '2026-07-01T00:00:00.000Z',
        weekEnd: '2026-07-15T23:59:59.999Z',
        requestId: '12121212-1212-4212-8212-121212121212',
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'PRECONDITION_FAILED' }),
    )
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.getVenueReportConfiguration returns the fail-closed default for an existing venue', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.getVenueReportConfiguration({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).resolves.toEqual({
      id: null,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: false,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
    })
  })

  it('admin.updateVenueReportConfiguration creates and strictly audits an enabled setting', async () => {
    const createdAt = new Date('2026-08-08T09:00:00.000Z')
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce(null)
    venueReportConfigurationCreate.mockResolvedValueOnce({
      id: 'config_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: true,
      updatedBy: 'admin_1',
      createdAt,
      updatedAt: createdAt,
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.updateVenueReportConfiguration({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: true,
      expectedUpdatedAt: null,
    })

    expect(result).toMatchObject({ id: 'config_1', enabled: true, replayed: false })
    expect(lockVenueReportMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.venue-reports.enabled',
          targetId: 'config_1',
          beforeState: { enabled: false },
          afterState: { enabled: true },
        }),
      }),
    )
  })

  it('admin.updateVenueReportConfiguration rejects a stale revision without a write or audit', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({
      id: 'config_1',
      enabled: true,
      updatedAt: new Date('2026-08-08T10:00:00.000Z'),
    })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.updateVenueReportConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedUpdatedAt: new Date('2026-08-08T09:00:00.000Z'),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(venueReportConfigurationUpdate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it('admin.updateVenueReportConfiguration advances its CAS token within the same millisecond', async () => {
    const revision = new Date('2026-08-08T10:00:00.000Z')
    const nextRevision = new Date('2026-08-08T10:00:00.001Z')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(revision.getTime())
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({
      id: 'config_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: true,
      updatedBy: 'admin_1',
      createdAt: revision,
      updatedAt: revision,
    })
    venueReportConfigurationUpdate.mockResolvedValueOnce({
      id: 'config_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: false,
      updatedBy: 'admin_1',
      createdAt: revision,
      updatedAt: nextRevision,
    })

    const caller = testRouter.createCaller(adminCtx())
    await caller.admin.updateVenueReportConfiguration({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: false,
      expectedUpdatedAt: revision,
    })

    expect(venueReportConfigurationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ updatedAt: nextRevision }) }),
    )
    nowSpy.mockRestore()
  })

  it('admin.generateWeeklyReportDraft rejects a venue outside the supplied tenant', async () => {
    venueFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.generateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'other_tenant_venue',
        weekStart: '2026-07-01T00:00:00.000Z',
        weekEnd: '2026-07-07T23:59:59.999Z',
        requestId: '77777777-7777-4777-8777-777777777777',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'other_tenant_venue', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.generateWeeklyReportDraft replays an exact request without duplicate writes', async () => {
    generationRequestDispatchFindFirst.mockResolvedValueOnce({
      id: 'dispatch_existing',
      recordId: 'report_existing',
      requestHash: generationRequestHash({
        kind: 'WEEKLY_REPORT',
        venueId: 'venue_1',
        rangeStart: new Date('2026-07-01T00:00:00.000Z'),
        rangeEnd: new Date('2026-07-07T23:59:59.999Z'),
        title: 'PathFinder Weekly Report',
      }),
      status: 'PENDING',
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateWeeklyReportDraft({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: '2026-07-01T00:00:00.000Z',
      weekEnd: '2026-07-07T23:59:59.999Z',
      requestId: '88888888-8888-4888-8888-888888888888',
    })

    expect(result).toEqual({
      reportId: 'report_existing',
      requestId: '88888888-8888-4888-8888-888888888888',
      dispatchState: 'PENDING',
      replayed: true,
    })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).toHaveBeenCalledWith('dispatch_existing')
  })

  it('admin.generateWeeklyReportDraft rejects reuse of a request ID for changed input', async () => {
    generationRequestDispatchFindFirst.mockResolvedValueOnce({
      id: 'dispatch_existing',
      recordId: 'report_existing',
      requestHash: 'f'.repeat(64),
      status: 'PENDING',
    })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.generateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        weekStart: '2026-07-01T00:00:00.000Z',
        weekEnd: '2026-07-07T23:59:59.999Z',
        title: 'Changed title',
        requestId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Request ID was already used for different report input.',
    })

    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.generateWeeklyReportDraft preserves durable success when the best-effort kick fails', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    enqueueGenerationDispatchKick.mockRejectedValueOnce(
      new Error('redis://private-host queue unavailable'),
    )

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateWeeklyReportDraft({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: '2026-07-01T00:00:00.000Z',
      weekEnd: '2026-07-07T23:59:59.999Z',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })

    expect(result).toEqual({
      reportId: expect.any(String),
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      dispatchState: 'PENDING',
      replayed: false,
    })
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.weekly-report.dispatch-kick.failed',
        error: 'Durable report request is pending dispatcher retry.',
      }),
    )
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('private-host')
  })

  it('admin.getWeeklyReport scopes report detail to the supplied tenant and venue', async () => {
    const report = { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' }
    weeklyReportFindFirst.mockResolvedValueOnce(report)

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.getWeeklyReport({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      reportId: 'report_1',
    })

    expect(weeklyReportFindFirst).toHaveBeenCalledWith({
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
    })
    expect(result).toEqual(report)
  })

  it('admin.getWeeklyReport returns NOT_FOUND when the report is outside the supplied venue', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.getWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
        reportId: 'report_1',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(weeklyReportFindFirst).toHaveBeenCalledWith({
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'wrong_venue' },
    })
  })

  it.each(['PUBLISHED', 'GENERATING', 'FAILED'])(
    'admin.updateWeeklyReportDraft throws BAD_REQUEST on a %s report',
    async (status) => {
      weeklyReportFindFirst.mockResolvedValueOnce({ status, updatedAt: reportRevision })

      const caller = testRouter.createCaller(adminCtx())

      await expect(
        caller.admin.updateWeeklyReportDraft({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          reportId: 'report_1',
          expectedUpdatedAt: reportRevision.toISOString(),
          content: 'Edited content',
        }),
      ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
      expect(weeklyReportFindFirst).toHaveBeenCalledWith({
        where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
        select: { status: true, updatedAt: true },
      })
      expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
      expect(writeAuditLogMock).not.toHaveBeenCalled()
    },
  )

  it('admin.updateWeeklyReportDraft returns NOT_FOUND for a report outside the supplied venue', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.updateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
        content: 'Edited content',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.updateWeeklyReportDraft uses an exact DRAFT CAS and audit-logs a successful edit', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', updatedAt: reportRevision })
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(reportRevision.getTime())

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.updateWeeklyReportDraft({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      reportId: 'report_1',
      expectedUpdatedAt: reportRevision.toISOString(),
      title: 'Edited title',
      content: 'Edited content',
    })

    expect(result).toEqual({
      ok: true,
      updatedAt: expect.any(String),
    })
    const nextUpdatedAt = new Date(result.updatedAt)
    expect(nextUpdatedAt.getTime()).toBe(reportRevision.getTime() + 1)
    expect(weeklyReportUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'DRAFT',
        updatedAt: reportRevision,
      },
      data: { title: 'Edited title', content: 'Edited content', updatedAt: nextUpdatedAt },
    })
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.report.edited', targetId: 'report_1' }),
    )
    expect(weeklyReportUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      writeAuditLogMock.mock.invocationCallOrder[0]!,
    )
    dateNow.mockRestore()
  })

  it('admin.updateWeeklyReportDraft returns CONFLICT without an audit when its DRAFT CAS misses', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', updatedAt: reportRevision })
    weeklyReportUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.updateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
        content: 'Edited content',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(weeklyReportUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'report_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          status: 'DRAFT',
          updatedAt: reportRevision,
        },
      }),
    )
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.updateWeeklyReportDraft rejects a stale revision before attempting its CAS', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({
      status: 'DRAFT',
      updatedAt: new Date('2026-08-08T12:01:00.000Z'),
    })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.updateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
        content: 'Stale edited content',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))

    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport throws BAD_REQUEST when status is not DRAFT', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'GENERATING', content: null })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport throws BAD_REQUEST when the draft has no content', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', content: null })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport returns NOT_FOUND for a report outside the supplied venue', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'wrong_venue',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
    expect(weeklyReportFindFirst).toHaveBeenCalledWith({
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'wrong_venue' },
      select: { status: true, content: true, updatedAt: true },
    })
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogMock).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport publishes a valid draft and audit-logs it', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({
      status: 'DRAFT',
      content: 'Some content',
      updatedAt: reportRevision,
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.publishWeeklyReport({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      reportId: 'report_1',
      expectedUpdatedAt: reportRevision.toISOString(),
    })

    expect(result).toEqual({ ok: true })
    expect(weeklyReportUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'DRAFT',
        updatedAt: reportRevision,
      },
      data: expect.objectContaining({ status: 'PUBLISHED' }),
    })
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'admin.report.published', targetId: 'report_1' }),
      }),
    )
  })

  it('admin.publishWeeklyReport returns CONFLICT without an audit when its DRAFT CAS misses', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({
      status: 'DRAFT',
      content: 'Some content',
      updatedAt: reportRevision,
    })
    weeklyReportUpdateMany.mockResolvedValueOnce({ count: 0 })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(weeklyReportUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'report_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          status: 'DRAFT',
          updatedAt: reportRevision,
        },
      }),
    )
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport rejects a disabled venue before reading or publishing', async () => {
    venueReportConfigurationFindFirst.mockResolvedValueOnce(null)
    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'PRECONDITION_FAILED' }),
    )
    expect(weeklyReportFindFirst).not.toHaveBeenCalled()
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it('all new admin.* chatlog/report/analysis procedures throw FORBIDDEN for non-admin users', async () => {
    const caller = testRouter.createCaller(nonAdminCtx())

    await expect(
      caller.admin.listVenueSessions({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    await expect(
      caller.admin.setSessionNotable({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        isNotable: true,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    await expect(
      caller.admin.publishWeeklyReport({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })
})
