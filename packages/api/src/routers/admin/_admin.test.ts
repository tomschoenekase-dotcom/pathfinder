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
  messageFindMany,
  questionClusterFindMany,
  firstWeekAccountReviewFindMany,
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
  venueReportConfigurationUpdateMany,
  executeRaw,
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
  ensureOrganizationInvitationMock,
  validateExistingOrganizationOwnerMock,
  loggerWarn,
  lockVenueReportMutation,
  createClientAccountActionMock,
  linkProspectConversionActionMock,
  setClientPaymentDueActionMock,
  updateClientPlanTierActionMock,
  updateClientStatusActionMock,
  beginClientCreateIntentActionMock,
  confirmClientCreateProviderActionMock,
  completeClientCreateIntentActionMock,
  startClientCreateProviderActionMock,
  setChatlogNotableActionMock,
  addChatlogNoteActionMock,
  prepareWeeklyDigestIntentActionMock,
  recordOrReplayOnboardingMilestoneEventMock,
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
  messageFindMany: vi.fn(),
  questionClusterFindMany: vi.fn(),
  firstWeekAccountReviewFindMany: vi.fn(),
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
  venueReportConfigurationUpdateMany: vi.fn(),
  executeRaw: vi.fn(),
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
  ensureOrganizationInvitationMock: vi.fn(),
  validateExistingOrganizationOwnerMock: vi.fn(),
  loggerWarn: vi.fn(),
  lockVenueReportMutation: vi.fn(),
  createClientAccountActionMock: vi.fn(),
  linkProspectConversionActionMock: vi.fn(),
  setClientPaymentDueActionMock: vi.fn(),
  updateClientPlanTierActionMock: vi.fn(),
  updateClientStatusActionMock: vi.fn(),
  beginClientCreateIntentActionMock: vi.fn(),
  confirmClientCreateProviderActionMock: vi.fn(),
  completeClientCreateIntentActionMock: vi.fn(),
  startClientCreateProviderActionMock: vi.fn(),
  setChatlogNotableActionMock: vi.fn(),
  addChatlogNoteActionMock: vi.fn(),
  prepareWeeklyDigestIntentActionMock: vi.fn(),
  recordOrReplayOnboardingMilestoneEventMock: vi.fn(),
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { warn: loggerWarn },
}))

vi.mock('@pathfinder/db', async (importOriginal) => {
  const { z } = await import('zod')
  const weeklyReportActions = await importOriginal<typeof import('@pathfinder/db')>()
  const transactionDb = {
    $executeRaw: executeRaw,
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
      findMany: messageFindMany,
    },
    questionCluster: {
      findMany: questionClusterFindMany,
    },
    firstWeekAccountReview: {
      findMany: firstWeekAccountReviewFindMany,
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
      updateMany: venueReportConfigurationUpdateMany,
    },
    generationRequestDispatch: {
      findFirst: generationRequestDispatchFindFirst,
      create: generationRequestDispatchCreate,
    },
    auditLog: { create: auditLogCreate },
  }
  return {
    ...weeklyReportActions,
    PROSPECT_OUTREACH_RELEASE_POLICY: weeklyReportActions.PROSPECT_OUTREACH_RELEASE_POLICY,
    SUPPORT_TRIAGE_MISSING_INFORMATION_MAX: 30,
    SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX: 500,
    LegacyContentActionError: class LegacyContentActionError extends Error {},
    ClientAccountActionError: class ClientAccountActionError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message)
      }
    },
    ClientCreateIntentError: class ClientCreateIntentError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message)
      }
    },
    ChatlogReviewActionError: class ChatlogReviewActionError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message)
      }
    },
    WeeklyDigestIntentActionError: class WeeklyDigestIntentActionError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message)
      }
    },
    prepareWeeklyDigestIntentAction: prepareWeeklyDigestIntentActionMock,
    setChatlogNotableAction: setChatlogNotableActionMock,
    addChatlogNoteAction: addChatlogNoteActionMock,
    beginClientCreateIntentAction: beginClientCreateIntentActionMock,
    confirmClientCreateProviderAction: confirmClientCreateProviderActionMock,
    completeClientCreateIntentAction: completeClientCreateIntentActionMock,
    startClientCreateProviderAction: startClientCreateProviderActionMock,
    createClientAccountAction: createClientAccountActionMock,
    linkProspectConversionAction: linkProspectConversionActionMock,
    setClientPaymentDueAction: setClientPaymentDueActionMock,
    updateClientPlanTierAction: updateClientPlanTierActionMock,
    updateClientStatusAction: updateClientStatusActionMock,
    recordOrReplayOnboardingMilestoneEvent: recordOrReplayOnboardingMilestoneEventMock,
    createLegacyPlaceAction: vi.fn(),
    updateLegacyPlaceAction: vi.fn(),
    retireLegacyPlaceAction: vi.fn(),
    createLegacyKnowledgeAction: vi.fn(),
    updateLegacyKnowledgeAction: vi.fn(),
    retireLegacyKnowledgeAction: vi.fn(),
    IntakeActionError: class IntakeActionError extends Error {},
    websiteProposalInput: z
      .object({ kind: z.literal('WEBSITE'), displayName: z.string(), websiteUri: z.string().url() })
      .strict(),
    interviewProposalInput: z
      .object({ kind: z.literal('INTERVIEW'), displayName: z.string(), submission: z.unknown() })
      .strict(),
    notesProposalInput: z.object({ kind: z.literal('NOTES'), notes: z.string() }).strict(),
    createIntakeProposal: vi.fn(),
    listIntakeProposals: vi.fn(),
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
    WeeklyReportActionError: weeklyReportActions.WeeklyReportActionError,
    updateWeeklyReportConfigurationAction:
      weeklyReportActions.updateWeeklyReportConfigurationAction,
    updateWeeklyReportDraftAction: weeklyReportActions.updateWeeklyReportDraftAction,
    publishWeeklyReportAction: weeklyReportActions.publishWeeklyReportAction,
    AnswerAnalysisRequestActionError: weeklyReportActions.AnswerAnalysisRequestActionError,
    requestAnswerAnalysisAction: weeklyReportActions.requestAnswerAnalysisAction,
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
    ensureOrganizationInvitation: ensureOrganizationInvitationMock,
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
    venueFindFirst.mockResolvedValue({ id: 'venue_1', isActive: true })
    venueReportConfigurationFindFirst.mockResolvedValue({ enabled: true })
    lockVenueReportMutation.mockResolvedValue(undefined)
    validateExistingOrganizationOwnerMock.mockResolvedValue({
      organizationId: 'org_existing',
      userId: 'user_owner',
      emailAddress: 'Owner@Example.com',
    })
    createClientAccountActionMock.mockResolvedValue({
      tenant: { id: 'org_existing', name: 'Existing Organization', slug: 'existing-organization' },
      venue: null,
      replayed: false,
    })
    setClientPaymentDueActionMock.mockResolvedValue({})
    updateClientPlanTierActionMock.mockResolvedValue({})
    updateClientStatusActionMock.mockResolvedValue({})
    beginClientCreateIntentActionMock.mockResolvedValue({ state: 'READY' })
    startClientCreateProviderActionMock.mockResolvedValue({ state: 'CALL_PROVIDER' })
    confirmClientCreateProviderActionMock.mockResolvedValue({})
    completeClientCreateIntentActionMock.mockResolvedValue({
      createdAt: new Date('2026-08-18T12:00:00.000Z'),
    })
    recordOrReplayOnboardingMilestoneEventMock.mockResolvedValue({
      event: { id: 'milestone_1' },
      replayed: false,
    })
    ensureOrganizationInvitationMock.mockResolvedValue({ id: 'invite_1', replayed: false })
    prepareWeeklyDigestIntentActionMock.mockResolvedValue({
      id: 'digest_1',
      status: 'PENDING',
      enqueueAllowed: true,
      outcome: 'CREATED',
    })
    setChatlogNotableActionMock.mockResolvedValue({
      id: 'session_1',
      isNotable: true,
      replayed: false,
    })
    addChatlogNoteActionMock.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      note: 'Guest was confused about wait times.',
      authorId: 'admin_1',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
      replayed: false,
    })
    generationRequestDispatchCreate.mockImplementation(async ({ data }) => ({
      id: data.id,
      recordId: data.recordId,
      requestHash: data.requestHash,
      status: 'PENDING',
    }))
  })

  it('admin.triggerDigest creates a digest for the current week and enqueues it', async () => {
    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_1' })
    expect(prepareWeeklyDigestIntentActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_1',
      }),
    )
  })

  it('admin.triggerDigest reuses the current week digest when one already exists', async () => {
    prepareWeeklyDigestIntentActionMock.mockResolvedValueOnce({
      id: 'digest_existing',
      status: 'PENDING',
      enqueueAllowed: true,
      outcome: 'REPLAYED',
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.triggerDigest({ tenantId: 'tenant_1' })

    expect(result).toEqual({ digestId: 'digest_existing' })
    expect(enqueueWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        digestId: 'digest_existing',
      }),
    )
  })

  it('admin.triggerDigest does not enqueue processing or complete work', async () => {
    prepareWeeklyDigestIntentActionMock.mockResolvedValueOnce({
      id: 'digest_processing',
      status: 'PROCESSING',
      enqueueAllowed: false,
      outcome: 'REPLAYED',
    })

    const caller = testRouter.createCaller(adminCtx())
    await expect(caller.admin.triggerDigest({ tenantId: 'tenant_1' })).resolves.toEqual({
      digestId: 'digest_processing',
    })
    expect(enqueueWeeklyDigest).not.toHaveBeenCalled()
  })

  it('admin.triggerDigest throws NOT_FOUND when the tenant does not exist', async () => {
    const { WeeklyDigestIntentActionError } = await import('@pathfinder/db')
    prepareWeeklyDigestIntentActionMock.mockRejectedValueOnce(
      new WeeklyDigestIntentActionError('NOT_FOUND', 'Client not found.'),
    )

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
          venueId: 'venue_1',
          startedAt,
          lastActiveAt: startedAt,
          visitorId: 'visitor_1',
          venue: { name: 'Main Venue' },
          _count: { messages: 1 },
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
    firstWeekAccountReviewFindMany.mockResolvedValueOnce([
      {
        id: 'review_1',
        venueId: 'venue_1',
        milestone: 'DAY_3',
        releaseAt: new Date('2026-06-28T00:00:00.000Z'),
        dueAt: new Date('2026-07-01T00:00:00.000Z'),
        metrics: {
          publicSessions: 3,
          guestQuestions: 5,
          lowConfidenceInsights: 1,
          knowledgeGapInsights: 0,
          negativeFeedback: 0,
          supportRequestsCreated: 0,
          aiRequests: 5,
          failedAiRequests: 0,
          estimatedAiCostUsd: '0.02',
        },
        disposition: 'DRAFT_READY',
        draftSubject: 'A quick first-week check-in',
        draftBody: 'Draft only.',
        draftReason: 'Review before sending.',
        createdAt: new Date('2026-07-01T00:05:00.000Z'),
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
    expect(result.recentSessions[0]?.messageCount).toBe(1)
    expect(result.recentSessions[0]).not.toHaveProperty('messages')
    expect(result.questionClusters).toHaveLength(1)
    expect(result.firstWeekReviews).toEqual([
      expect.objectContaining({
        id: 'review_1',
        milestone: 'DAY_3',
        communicationAuthority: 'draft-only',
      }),
    ])
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['visitorId'],
        where: expect.objectContaining({ experienceScope: 'PUBLIC' }),
      }),
    )
    expect(visitorSessionCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ experienceScope: 'PUBLIC' }),
      }),
    )
    expect(messageCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ session: { experienceScope: 'PUBLIC' } }),
      }),
    )
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        select: expect.objectContaining({
          venueId: true,
          venue: { select: { name: true } },
          _count: { select: { messages: { where: { role: 'user' } } } },
        }),
      }),
    )
  })

  it('admin.getClientAnalytics throws NOT_FOUND when the tenant does not exist', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    visitorSessionCount.mockResolvedValueOnce(0)
    messageCount.mockResolvedValueOnce(0)
    visitorSessionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    questionClusterFindMany.mockResolvedValueOnce([])
    firstWeekAccountReviewFindMany.mockResolvedValueOnce([])

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
        {
          date: new Date('2026-08-07T00:00:00.000Z'),
          venueId: null,
          feature: 'weekly-digest',
          requestCount: 1,
          successfulRequestCount: 1,
          failedRequestCount: 0,
          totalTokens: 170,
          estimatedCostUsd: '0.00111000',
          venue: null,
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
        requestCount: 4,
        successfulRequestCount: 3,
        failedRequestCount: 1,
        totalTokens: 295,
        estimatedCostUsd: '0.10111003',
      })
      expect(result.costs.map((row) => row.estimatedCostUsd)).toEqual([
        '0.10000001',
        '0.00000002',
        '0.00111000',
      ])
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
        {
          venueId: null,
          venueName: 'Tenant-wide',
          requestCount: 1,
          totalTokens: 170,
          estimatedCostUsd: '0.00111000',
          features: [
            {
              feature: 'weekly-digest',
              requestCount: 1,
              totalTokens: 170,
              estimatedCostUsd: '0.00111000',
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
    const session = { id: 'session_1', venueId: 'venue_1', messageCount: 2 }
    visitorSessionFindFirst.mockResolvedValueOnce(session)
    messageFindMany.mockResolvedValueOnce([
      {
        id: 'message_2',
        role: 'assistant',
        content: 'Answer',
        createdAt: new Date('2026-08-27T12:02:00.000Z'),
        sessionSequence: 2,
      },
      {
        id: 'message_1',
        role: 'user',
        content: 'Question',
        createdAt: new Date('2026-08-27T12:01:00.000Z'),
        sessionSequence: 1,
      },
    ])

    const result = await testRouter.createCaller(adminCtx()).admin.getSessionChatlog({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
    })

    expect(result).toEqual({
      ...session,
      messages: [
        expect.objectContaining({ id: 'message_1', sessionSequence: 1 }),
        expect.objectContaining({ id: 'message_2', sessionSequence: 2 }),
      ],
      nextBeforeSequence: null,
    })
    expect(visitorSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'session_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        },
      }),
    )
    expect(messageFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', venueId: 'venue_1', sessionId: 'session_1' },
      orderBy: { sessionSequence: 'desc' },
      take: 51,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
        sessionSequence: true,
      },
    })
  })

  it('admin.getSessionChatlog returns a bounded stable older-message cursor', async () => {
    visitorSessionFindFirst.mockResolvedValueOnce({
      id: 'session_1',
      venueId: 'venue_1',
      messageCount: 500,
    })
    messageFindMany.mockResolvedValueOnce([
      { id: 'm9', sessionSequence: 9 },
      { id: 'm8', sessionSequence: 8 },
      { id: 'm7', sessionSequence: 7 },
    ])

    const result = await testRouter.createCaller(adminCtx()).admin.getSessionChatlog({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      messageLimit: 2,
      beforeSequence: 10,
    })

    expect(result.messages.map((message: { id: string }) => message.id)).toEqual(['m8', 'm9'])
    expect(result.nextBeforeSequence).toBe(8)
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionSequence: { lt: 10 } }),
        take: 3,
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
    expect(messageFindMany).not.toHaveBeenCalled()
  })

  it('admin.setSessionNotable delegates exact scope and platform actor to the canonical action', async () => {
    const caller = testRouter.createCaller(adminCtx())

    const result = await caller.admin.setSessionNotable({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      isNotable: true,
    })
    expect(result).toEqual({ ok: true })
    expect(setChatlogNotableActionMock).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        isNotable: true,
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('admin.setSessionNotable maps canonical scope failure to NOT_FOUND', async () => {
    const { ChatlogReviewActionError } = await import('@pathfinder/db')
    setChatlogNotableActionMock.mockRejectedValueOnce(
      new ChatlogReviewActionError('NOT_FOUND', 'Session not found.'),
    )

    await expect(
      testRouter.createCaller(adminCtx()).admin.setSessionNotable({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'other_tenant_session',
        isNotable: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('admin.addChatlogNote passes stable request identity and session-derived actor', async () => {
    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.addChatlogNote({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      sessionId: 'session_1',
      requestId: '11111111-1111-4111-8111-111111111111',
      note: 'Guest was confused about wait times.',
    })
    expect(result).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      note: 'Guest was confused about wait times.',
      authorId: 'admin_1',
      createdAt: new Date('2026-08-11T20:00:00.000Z'),
    })
    expect(addChatlogNoteActionMock).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        requestId: '11111111-1111-4111-8111-111111111111',
        note: 'Guest was confused about wait times.',
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('admin.addChatlogNote maps request collisions to CONFLICT', async () => {
    const { ChatlogReviewActionError } = await import('@pathfinder/db')
    addChatlogNoteActionMock.mockRejectedValueOnce(
      new ChatlogReviewActionError('CONFLICT', 'Request ID collision.'),
    )
    await expect(
      testRouter.createCaller(adminCtx()).admin.addChatlogNote({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        sessionId: 'session_1',
        requestId: '11111111-1111-4111-8111-111111111111',
        note: 'Private detail.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
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
      select: { id: true, isActive: true },
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

  it('admin.generateAnswerAnalysis rejects an inverted range before transaction or enqueue', async () => {
    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.generateAnswerAnalysis({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        rangeStart: '2026-08-01T00:00:00.000Z',
        rangeEnd: '2026-07-31T23:59:59.999Z',
        requestId: '11111111-1111-4111-8111-111111111112',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Analysis range start must be before or equal to range end',
    })

    expect(dbTransaction).not.toHaveBeenCalled()
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
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
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true, isActive: true },
    })
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
      select: { id: true, isActive: true },
    })
    expect(answerAnalysisSnapshotCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.generateAnswerAnalysis blocks an exact replay while the venue is inactive', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1', isActive: false })
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
    await expect(
      caller.admin.generateAnswerAnalysis({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        rangeStart: '2026-07-01T00:00:00.000Z',
        rangeEnd: '2026-07-31T23:59:59.999Z',
        requestId: '55555555-5555-4555-8555-555555555556',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    expect(generationRequestDispatchFindFirst).not.toHaveBeenCalled()
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
    expect(createClientAccountActionMock).toHaveBeenCalledWith({
      tenantId: 'org_existing',
      name: 'Existing Organization',
      slug: 'existing-organization',
      owner: { id: 'user_owner', email: 'Owner@Example.com' },
      actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
    })
    expect(result).toEqual({ ok: true })
  })

  it('admin.createClient performs no database work when Clerk identity validation fails', async () => {
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

    expect(createClientAccountActionMock).not.toHaveBeenCalled()
  })

  it('admin.createClient preserves an unexpected canonical action failure', async () => {
    createClientAccountActionMock.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toThrow('audit unavailable')

    expect(createClientAccountActionMock).toHaveBeenCalledOnce()
  })

  it('admin.createClient maps canonical account conflicts', async () => {
    const { ClientAccountActionError } = await import('@pathfinder/db')
    createClientAccountActionMock.mockRejectedValueOnce(
      new ClientAccountActionError('CONFLICT', 'Account details differ'),
    )

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClient({
        orgId: 'org_existing',
        name: 'Existing Organization',
        slug: 'existing-organization',
        userId: 'user_owner',
        userEmail: 'owner@example.com',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(validateExistingOrganizationOwnerMock).toHaveBeenCalledOnce()
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
    createClientAccountActionMock.mockResolvedValueOnce({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
      replayed: false,
    })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.createClientAndVenue({
      requestId: '77777777-7777-4777-8777-777777777777',
      clientName: 'The Grand Hotel',
      primaryContact: { emailAddress: 'owner@example.com', role: 'org:admin' },
      venue: { name: 'Main Lobby' },
    })

    expect(createOrganizationMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'The Grand Hotel', createdByUserId: 'admin_1' }),
    )
    expect(createClientAccountActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'org_new',
        owner: { id: 'admin_1', email: 'admin@pathfinder.test' },
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
        initialVenue: expect.objectContaining({ name: 'Main Lobby', slug: 'main-lobby' }),
      }),
    )
    expect(ensureOrganizationInvitationMock).toHaveBeenCalledWith({
      organizationId: 'org_new',
      emailAddress: 'owner@example.com',
      role: 'org:admin',
      inviterUserId: 'admin_1',
    })
    expect(recordOrReplayOnboardingMilestoneEventMock).toHaveBeenCalledWith({
      db: expect.any(Object),
      input: expect.objectContaining({
        tenantId: 'org_new',
        venueId: 'venue_new',
        eventType: 'INVITATION_STARTED',
        idempotencyKey: 'client-create:77777777-7777-4777-8777-777777777777:invitation',
        occurredAt: new Date('2026-08-18T12:00:00.000Z'),
        actorType: 'OPERATOR',
        actorId: 'admin_1',
        sourceType: 'ORGANIZATION_INVITATION',
        sourceId: 'invite_1',
      }),
    })
    expect(result).toEqual({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
      invitation: { id: 'invite_1', replayed: false },
    })
  })

  it('admin.createClientAndVenue rejects incoherent venue centers before provider access', async () => {
    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: {
          name: 'Main Lobby',
          guideMode: 'non_location',
          defaultCenterLat: 41.5,
          defaultCenterLng: -81.7,
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(createOrganizationMock).not.toHaveBeenCalled()
    expect(tenantCreate).not.toHaveBeenCalled()
    expect(venueCreate).not.toHaveBeenCalled()
  })

  it('binds prospect conversion before the durable client-create intent completes', async () => {
    createOrganizationMock.mockResolvedValueOnce({
      id: 'org_new',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    tenantFindUnique.mockResolvedValueOnce(null)
    createClientAccountActionMock.mockResolvedValueOnce({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
      replayed: false,
    })

    await testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
      requestId: '77777777-7777-4777-8777-777777777777',
      clientName: 'The Grand Hotel',
      prospectConversion: {
        organizationId: 'prospect_1',
        prospectVenueId: 'prospect_venue_1',
      },
      venue: { name: 'Main Lobby' },
    })

    expect(linkProspectConversionActionMock).toHaveBeenCalledWith({
      organizationId: 'prospect_1',
      prospectVenueId: 'prospect_venue_1',
      tenantId: 'org_new',
      venueId: 'venue_new',
      evidence: { clientCreateRequestId: '77777777-7777-4777-8777-777777777777' },
      actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
    })
    expect(linkProspectConversionActionMock.mock.invocationCallOrder[0]).toBeLessThan(
      completeClientCreateIntentActionMock.mock.invocationCallOrder[0]!,
    )
  })

  it('does not complete the client-create intent when prospect continuity fails', async () => {
    createOrganizationMock.mockResolvedValueOnce({
      id: 'org_new',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    tenantFindUnique.mockResolvedValueOnce(null)
    createClientAccountActionMock.mockResolvedValueOnce({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
      replayed: false,
    })
    linkProspectConversionActionMock.mockRejectedValueOnce(new Error('conversion unavailable'))

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        prospectConversion: { organizationId: 'prospect_1' },
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('local client setup did not complete'),
    })

    expect(completeClientCreateIntentActionMock).not.toHaveBeenCalled()
    expect(ensureOrganizationInvitationMock).not.toHaveBeenCalled()
  })

  it('admin.createClientAndVenue throws FORBIDDEN for non-admin users', async () => {
    const caller = testRouter.createCaller(nonAdminCtx())

    await expect(
      caller.admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(createOrganizationMock).not.toHaveBeenCalled()
  })

  it('admin.createClientAndVenue reports an unconfirmed provider outcome without local work', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    createOrganizationMock.mockRejectedValueOnce(new Error('provider timeout'))
    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('outcome is unconfirmed'),
    })
    expect(createClientAccountActionMock).not.toHaveBeenCalled()
  })

  it('admin.createClientAndVenue blocks an ambiguous-request retry before provider access', async () => {
    beginClientCreateIntentActionMock.mockResolvedValueOnce({
      state: 'RECONCILIATION_REQUIRED',
    })

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Reconcile') })

    expect(createOrganizationMock).not.toHaveBeenCalled()
    expect(createClientAccountActionMock).not.toHaveBeenCalled()
  })

  it('admin.createClientAndVenue resumes a confirmed provider result without creating another org', async () => {
    beginClientCreateIntentActionMock.mockResolvedValueOnce({
      state: 'PROVIDER_CONFIRMED',
      providerOrganizationId: 'org_new',
      localSlug: 'the-grand-hotel',
    })
    tenantFindUnique.mockResolvedValueOnce(null)
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    validateExistingOrganizationOwnerMock.mockResolvedValueOnce({
      organizationId: 'org_new',
      organizationName: 'The Grand Hotel',
      organizationSlug: 'org_new',
      userId: 'admin_1',
      emailAddress: 'admin@pathfinder.test',
    })
    createClientAccountActionMock.mockResolvedValueOnce({
      tenant: { id: 'org_new', name: 'The Grand Hotel', slug: 'the-grand-hotel' },
      venue: { id: 'venue_new', name: 'Main Lobby', slug: 'main-lobby' },
      replayed: false,
    })

    await testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
      requestId: '77777777-7777-4777-8777-777777777777',
      clientName: 'The Grand Hotel',
      venue: { name: 'Main Lobby' },
    })

    expect(validateExistingOrganizationOwnerMock).toHaveBeenCalledWith({
      organizationId: 'org_new',
      userId: 'admin_1',
      emailAddress: 'admin@pathfinder.test',
    })
    expect(createOrganizationMock).not.toHaveBeenCalled()
    expect(createClientAccountActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'the-grand-hotel' }),
    )
  })

  it('admin.reconcileClientAndVenue claims only a currently verified owned organization', async () => {
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    validateExistingOrganizationOwnerMock.mockResolvedValueOnce({
      organizationId: 'org_reconciled',
      organizationName: 'The Grand Hotel',
      organizationSlug: 'the-grand-hotel',
      userId: 'admin_1',
      emailAddress: 'admin@pathfinder.test',
    })

    await expect(
      testRouter.createCaller(adminCtx()).admin.reconcileClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        organizationId: 'org_reconciled',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).resolves.toEqual({ confirmed: true })

    expect(confirmClientCreateProviderActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '77777777-7777-4777-8777-777777777777',
        providerOrganizationId: 'org_reconciled',
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })

  it('admin.reconcileClientAndVenue maps a cross-intent provider claim to conflict', async () => {
    const { ClientCreateIntentError } = await import('@pathfinder/db')
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    validateExistingOrganizationOwnerMock.mockResolvedValueOnce({
      organizationId: 'org_claimed',
      organizationName: 'Claimed Organization',
      organizationSlug: 'claimed-organization',
      userId: 'admin_1',
      emailAddress: 'admin@pathfinder.test',
    })
    confirmClientCreateProviderActionMock.mockRejectedValueOnce(
      new ClientCreateIntentError('CONFLICT', 'Provider organization is already claimed'),
    )

    await expect(
      testRouter.createCaller(adminCtx()).admin.reconcileClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        organizationId: 'org_claimed',
        clientName: 'Claimed Organization',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Provider organization is already claimed',
    })
  })

  it('admin.createClientAndVenue reports provider success plus incomplete local setup', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    createOrganizationMock.mockResolvedValueOnce({
      id: 'org_new',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    createClientAccountActionMock.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('provider organization exists'),
    })
  })

  it('admin.createClientAndVenue maps a provider claim collision before local account work', async () => {
    const { ClientCreateIntentError } = await import('@pathfinder/db')
    tenantFindUnique.mockResolvedValueOnce(null)
    currentUserMock.mockResolvedValueOnce({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [{ id: 'email_1', emailAddress: 'admin@pathfinder.test' }],
    })
    createOrganizationMock.mockResolvedValueOnce({
      id: 'org_claimed',
      name: 'The Grand Hotel',
      slug: 'the-grand-hotel',
    })
    confirmClientCreateProviderActionMock.mockRejectedValueOnce(
      new ClientCreateIntentError('CONFLICT', 'Provider organization is already claimed'),
    )

    await expect(
      testRouter.createCaller(adminCtx()).admin.createClientAndVenue({
        requestId: '77777777-7777-4777-8777-777777777777',
        clientName: 'The Grand Hotel',
        venue: { name: 'Main Lobby' },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Provider organization is already claimed',
    })

    expect(createOrganizationMock).toHaveBeenCalledOnce()
    expect(createClientAccountActionMock).not.toHaveBeenCalled()
  })

  it('admin account metadata mutations pass exact CAS and platform actor to canonical actions', async () => {
    const caller = testRouter.createCaller(adminCtx())
    const expectedUpdatedAt = '2026-08-11T14:30:00.000Z'
    await caller.admin.updateClientStatus({
      tenantId: 'tenant_1',
      status: 'SUSPENDED',
      expectedUpdatedAt,
    })
    await caller.admin.updateClientPlanTier({
      tenantId: 'tenant_1',
      planTier: 'pro',
      expectedUpdatedAt,
    })
    await caller.admin.setTenantPaymentDue({
      tenantId: 'tenant_1',
      nextPaymentDue: '2026-09-01T00:00:00.000Z',
      expectedUpdatedAt,
    })
    const common = {
      tenantId: 'tenant_1',
      expectedUpdatedAt: new Date(expectedUpdatedAt),
      actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
    }
    expect(updateClientStatusActionMock).toHaveBeenCalledWith({
      ...common,
      status: 'SUSPENDED',
    })
    expect(updateClientPlanTierActionMock).toHaveBeenCalledWith({ ...common, planTier: 'pro' })
    expect(setClientPaymentDueActionMock).toHaveBeenCalledWith({
      ...common,
      nextPaymentDue: new Date('2026-09-01T00:00:00.000Z'),
    })
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
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true, isActive: true },
    })
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
    expect(executeRaw).toHaveBeenCalledOnce()
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
    venueReportConfigurationUpdateMany.mockResolvedValueOnce({ count: 1 })
    venueReportConfigurationFindFirst.mockResolvedValueOnce({
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

    expect(venueReportConfigurationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'config_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          updatedAt: revision,
        }),
        data: expect.objectContaining({ updatedAt: nextRevision }),
      }),
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
      select: { id: true, isActive: true },
    })
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it('admin.generateWeeklyReportDraft rejects an inverted range before durable work', async () => {
    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.generateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        weekStart: '2026-07-08T00:00:00.000Z',
        weekEnd: '2026-07-07T23:59:59.999Z',
        requestId: '77777777-7777-4777-8777-777777777778',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Report week start must be on or before week end.',
    })

    expect(dbTransaction).not.toHaveBeenCalled()
    expect(lockVenueReportMutation).not.toHaveBeenCalled()
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(generationRequestDispatchFindFirst).not.toHaveBeenCalled()
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
  })

  it.each(['Torchico Weekly Report', 'PathFinder Weekly Report'])(
    'admin.generateWeeklyReportDraft replays the legacy %s identity without duplicate writes',
    async (legacyTitle) => {
      generationRequestDispatchFindFirst.mockResolvedValueOnce({
        id: 'dispatch_existing',
        recordId: 'report_existing',
        requestHash: generationRequestHash({
          kind: 'WEEKLY_REPORT',
          venueId: 'venue_1',
          rangeStart: new Date('2026-07-01T00:00:00.000Z'),
          rangeEnd: new Date('2026-07-07T23:59:59.999Z'),
          title: legacyTitle,
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
      expect(venueFindFirst).toHaveBeenCalledWith({
        where: { id: 'venue_1', tenantId: 'tenant_1' },
        select: { id: true, isActive: true },
      })
      expect(weeklyReportCreate).not.toHaveBeenCalled()
      expect(generationRequestDispatchCreate).not.toHaveBeenCalled()
      expect(auditLogCreate).not.toHaveBeenCalled()
      expect(enqueueGenerationDispatchKick).toHaveBeenCalledWith('dispatch_existing')
    },
  )

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

  it('admin.generateWeeklyReportDraft blocks an exact replay while the venue is inactive', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1', isActive: false })

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.generateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        weekStart: '2026-07-01T00:00:00.000Z',
        weekEnd: '2026-07-07T23:59:59.999Z',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    expect(generationRequestDispatchFindFirst).not.toHaveBeenCalled()
    expect(enqueueGenerationDispatchKick).not.toHaveBeenCalled()
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
    expect(auditLogCreate).not.toHaveBeenCalled()
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
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'admin.report.edited',
          targetId: 'report_1',
          beforeState: {
            status: 'DRAFT',
            updatedAt: reportRevision.toISOString(),
          },
          afterState: {
            status: 'DRAFT',
            updatedAt: nextUpdatedAt.toISOString(),
          },
        }),
      }),
    )
    expect(weeklyReportUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreate.mock.invocationCallOrder[0]!,
    )
    expect(dbTransaction).toHaveBeenCalledOnce()
    expect(executeRaw).toHaveBeenCalledOnce()
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
    expect(auditLogCreate).not.toHaveBeenCalled()
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
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it('admin.updateWeeklyReportDraft fails the transaction when strict audit persistence fails', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', updatedAt: reportRevision })
    auditLogCreate.mockRejectedValueOnce(new Error('audit unavailable'))

    const caller = testRouter.createCaller(adminCtx())
    await expect(
      caller.admin.updateWeeklyReportDraft({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        reportId: 'report_1',
        expectedUpdatedAt: reportRevision.toISOString(),
        content: 'Edited content',
      }),
    ).rejects.toThrow('audit unavailable')

    expect(weeklyReportUpdateMany).toHaveBeenCalledOnce()
    expect(auditLogCreate).toHaveBeenCalledOnce()
    expect(dbTransaction).toHaveBeenCalledOnce()
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

  it('admin.listVenueSessions derives message counts from trusted user message rows', async () => {
    const startedAt = new Date('2026-08-09T07:00:00.000Z')
    visitorSessionFindMany.mockResolvedValueOnce([
      {
        id: 'session_1',
        startedAt,
        lastActiveAt: startedAt,
        isNotable: false,
        _count: { messages: 2, engagementResponses: 0, adminNotes: 0 },
      },
    ])

    const result = await testRouter.createCaller(adminCtx()).admin.listVenueSessions({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })

    expect(result.sessions).toEqual([
      {
        id: 'session_1',
        startedAt,
        lastActiveAt: startedAt,
        isNotable: false,
        messageCount: 2,
        _count: { engagementResponses: 0, adminNotes: 0 },
      },
    ])
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          _count: {
            select: {
              messages: { where: { role: 'user' } },
              engagementResponses: true,
              adminNotes: true,
            },
          },
        }),
      }),
    )
  })

  it('admin.listVenueSessions keeps the extra row and returns the last included row as its cursor', async () => {
    const startedAt = new Date('2026-08-09T07:00:00.000Z')
    visitorSessionFindMany.mockResolvedValueOnce([
      {
        id: 'session_2',
        startedAt,
        lastActiveAt: startedAt,
        isNotable: false,
        experienceScope: 'PUBLIC',
        _count: { messages: 1, engagementResponses: 0, adminNotes: 0 },
      },
      {
        id: 'session_1',
        startedAt,
        lastActiveAt: startedAt,
        isNotable: false,
        experienceScope: 'PUBLIC',
        _count: { messages: 1, engagementResponses: 0, adminNotes: 0 },
      },
    ])

    const result = await testRouter.createCaller(adminCtx()).admin.listVenueSessions({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      limit: 1,
    })

    expect(result.sessions.map((session) => session.id)).toEqual(['session_2'])
    expect(result.nextCursor).toBe('session_2')
    expect(visitorSessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 2 }),
    )
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
