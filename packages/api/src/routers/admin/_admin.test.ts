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
  visitorSessionFindMany,
  visitorSessionUpdateMany,
  messageCount,
  questionClusterFindMany,
  aiUsageDailyRollupFindMany,
  userUpsert,
  tenantMembershipUpsert,
  adminChatlogNoteCreate,
  weeklyReportFindUnique,
  weeklyReportCreate,
  weeklyReportUpdate,
  weeklyReportFindFirst,
  weeklyReportUpdateMany,
  venueFindFirst,
  venueCreate,
  writeAuditLogMock,
  enqueueWeeklyDigest,
  enqueueAnswerAnalysis,
  enqueueWeeklyReport,
  createOrganizationMock,
  currentUserMock,
} = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantCreate: vi.fn(),
  tenantUpdate: vi.fn(),
  weeklyDigestFindUnique: vi.fn(),
  weeklyDigestCreate: vi.fn(),
  visitorSessionCount: vi.fn(),
  visitorSessionFindMany: vi.fn(),
  visitorSessionUpdateMany: vi.fn(),
  messageCount: vi.fn(),
  questionClusterFindMany: vi.fn(),
  aiUsageDailyRollupFindMany: vi.fn(),
  userUpsert: vi.fn(),
  tenantMembershipUpsert: vi.fn(),
  adminChatlogNoteCreate: vi.fn(),
  weeklyReportFindUnique: vi.fn(),
  weeklyReportCreate: vi.fn(),
  weeklyReportUpdate: vi.fn(),
  weeklyReportFindFirst: vi.fn(),
  weeklyReportUpdateMany: vi.fn(),
  venueFindFirst: vi.fn(),
  venueCreate: vi.fn(),
  writeAuditLogMock: vi.fn(),
  enqueueWeeklyDigest: vi.fn(),
  enqueueAnswerAnalysis: vi.fn(),
  enqueueWeeklyReport: vi.fn(),
  createOrganizationMock: vi.fn(),
  currentUserMock: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
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
  },
  writeAuditLog: writeAuditLogMock,
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueWeeklyDigest,
  enqueueAnswerAnalysis,
  enqueueWeeklyReport,
}))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return {
    ...actual,
    createOrganization: createOrganizationMock,
    currentUser: currentUserMock,
  }
})

import { router } from '../../core'
import type { TRPCContext } from '../../context'
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
  beforeEach(() => {
    vi.resetAllMocks()
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

  it('admin.setSessionNotable writes an audit log with the correct action for true/false', async () => {
    const caller = testRouter.createCaller(adminCtx())

    await caller.admin.setSessionNotable({
      tenantId: 'tenant_1',
      sessionId: 'session_1',
      isNotable: true,
    })
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.chatlog.marked_notable', targetId: 'session_1' }),
    )

    await caller.admin.setSessionNotable({
      tenantId: 'tenant_1',
      sessionId: 'session_1',
      isNotable: false,
    })
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.chatlog.unmarked_notable', targetId: 'session_1' }),
    )
  })

  it('admin.addChatlogNote sources authorId from the admin session, not client input', async () => {
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

  it('admin.generateWeeklyReportDraft always creates a new row (no reuse) and accepts a custom title', async () => {
    venueFindFirst.mockResolvedValueOnce({ id: 'venue_1' })
    weeklyReportCreate.mockResolvedValueOnce({ id: 'report_new' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.generateWeeklyReportDraft({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: '2026-07-01T00:00:00.000Z',
      weekEnd: '2026-07-15T23:59:59.999Z',
      title: 'My custom report title',
    })

    expect(result).toEqual({ reportId: 'report_new' })
    expect(weeklyReportFindUnique).not.toHaveBeenCalled()
    expect(weeklyReportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'GENERATING',
          title: 'My custom report title',
        }),
      }),
    )
    expect(enqueueWeeklyReport).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1', reportId: 'report_new' }),
    )
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
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'other_tenant_venue', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(weeklyReportCreate).not.toHaveBeenCalled()
    expect(enqueueWeeklyReport).not.toHaveBeenCalled()
  })

  it('admin.updateWeeklyReportDraft throws BAD_REQUEST on a published report', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'PUBLISHED' })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.updateWeeklyReportDraft({
        tenantId: 'tenant_1',
        reportId: 'report_1',
        content: 'Edited content',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport throws BAD_REQUEST when status is not DRAFT', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'GENERATING', content: null })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.publishWeeklyReport({ tenantId: 'tenant_1', reportId: 'report_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
  })

  it('admin.publishWeeklyReport throws BAD_REQUEST when the draft has no content', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', content: null })

    const caller = testRouter.createCaller(adminCtx())

    await expect(
      caller.admin.publishWeeklyReport({ tenantId: 'tenant_1', reportId: 'report_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
    expect(weeklyReportUpdateMany).not.toHaveBeenCalled()
  })

  it('admin.publishWeeklyReport publishes a valid draft and audit-logs it', async () => {
    weeklyReportFindFirst.mockResolvedValueOnce({ status: 'DRAFT', content: 'Some content' })

    const caller = testRouter.createCaller(adminCtx())
    const result = await caller.admin.publishWeeklyReport({
      tenantId: 'tenant_1',
      reportId: 'report_1',
    })

    expect(result).toEqual({ ok: true })
    expect(weeklyReportUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report_1', tenantId: 'tenant_1' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    )
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.report.published', targetId: 'report_1' }),
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
        sessionId: 'session_1',
        isNotable: true,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    await expect(
      caller.admin.publishWeeklyReport({ tenantId: 'tenant_1', reportId: 'report_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })
})
