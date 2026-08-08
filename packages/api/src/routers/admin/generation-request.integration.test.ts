import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { enqueueGenerationDispatchKick, loggerWarn } = vi.hoisted(() => ({
  enqueueGenerationDispatchKick: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@pathfinder/config/logger', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueGenerationDispatchKick,
  enqueueWeeklyDigest: vi.fn(),
}))

vi.mock('@pathfinder/auth', () => ({
  requirePlatformAdmin: (session: { isPlatformAdmin?: boolean }) => {
    if (session.isPlatformAdmin !== true) throw new Error('Platform admin required')
  },
  createOrganization: vi.fn(),
  currentUser: vi.fn(),
}))

import { db } from '@pathfinder/db'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminRouter } from './_admin'

const integrationDescribe =
  process.env.RUN_GENERATION_REQUEST_DB_INTEGRATION === '1' ? describe : describe.skip

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for generation request integration')

  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error(
      'Generation request integration requires an exact-loopback pathfinder_disposable_* database',
    )
  }
}

integrationDescribe(
  'durable generation request identity (disposable PostgreSQL integration)',
  () => {
    const suffix = randomUUID().replaceAll('-', '')
    const tenantId = `generation-request-tenant-${suffix}`
    const venueId = `generation-request-venue-${suffix}`
    const secondVenueId = `generation-request-venue-2-${suffix}`
    const actorId = `generation-request-admin-${suffix}`
    const rangeStart = '2026-08-01T00:00:00.000Z'
    const rangeEnd = '2026-08-08T00:00:00.000Z'
    const testRouter = router({ admin: adminRouter })
    let disposableConfirmed = false

    function adminCtx(): TRPCContext {
      return {
        db,
        headers: new Headers(),
        session: {
          userId: actorId,
          activeTenantId: null,
          role: null,
          isPlatformAdmin: true,
        },
      }
    }

    beforeAll(async () => {
      assertDisposableDatabase()
      await db.tenant.create({
        data: { id: tenantId, name: 'Generation request integration', slug: tenantId },
      })
      disposableConfirmed = true
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Generation request venue', slug: venueId },
          {
            id: secondVenueId,
            tenantId,
            name: 'Second generation request venue',
            slug: secondVenueId,
          },
        ],
      })
    })

    beforeEach(async () => {
      vi.clearAllMocks()
      enqueueGenerationDispatchKick.mockResolvedValue(undefined)
      await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
      await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
      await db.weeklyReport.deleteMany({ where: { tenantId } })
      await db.auditLog.deleteMany({ where: { tenantId } })
    })

    afterAll(async () => {
      if (!disposableConfirmed) return
      await db.generationRequestDispatch.deleteMany({ where: { tenantId } })
      await db.answerAnalysisSnapshot.deleteMany({ where: { tenantId } })
      await db.weeklyReport.deleteMany({ where: { tenantId } })
      await db.auditLog.deleteMany({ where: { tenantId } })
      await db.venue.deleteMany({ where: { tenantId } })
      await db.tenant.deleteMany({ where: { id: tenantId } })
      await db.$disconnect()
    })

    it('converges 16 identical analysis requests on one durable identity', async () => {
      const caller = testRouter.createCaller(adminCtx())
      const requestId = randomUUID()
      const input = { tenantId, venueId, rangeStart, rangeEnd, requestId }

      const results = await Promise.all(
        Array.from({ length: 16 }, () => caller.admin.generateAnswerAnalysis(input)),
      )
      const snapshotIds = new Set(results.map((result) => result.snapshotId))
      expect(snapshotIds.size).toBe(1)
      expect(results.filter((result) => result.replayed === false)).toHaveLength(1)
      expect(results.filter((result) => result.replayed === true)).toHaveLength(15)
      expect(results.every((result) => result.dispatchState === 'PENDING')).toBe(true)

      await expect(
        Promise.all([
          db.answerAnalysisSnapshot.count({ where: { tenantId, venueId } }),
          db.generationRequestDispatch.count({
            where: { tenantId, kind: 'ANSWER_ANALYSIS', requestId },
          }),
          db.auditLog.count({
            where: { tenantId, action: 'admin.answer_analysis.requested' },
          }),
        ]),
      ).resolves.toEqual([1, 1, 1])

      await expect(caller.admin.generateAnswerAnalysis(input)).resolves.toMatchObject({
        snapshotId: results[0]!.snapshotId,
        requestId,
        dispatchState: 'PENDING',
        replayed: true,
      })
    })

    it('rejects reused analysis IDs with changed range or venue without writes', async () => {
      const caller = testRouter.createCaller(adminCtx())
      const requestId = randomUUID()
      const input = { tenantId, venueId, rangeStart, rangeEnd, requestId }
      await caller.admin.generateAnswerAnalysis(input)

      const countsBefore = await Promise.all([
        db.answerAnalysisSnapshot.count({ where: { tenantId } }),
        db.generationRequestDispatch.count({ where: { tenantId } }),
        db.auditLog.count({ where: { tenantId } }),
      ])
      await expect(
        caller.admin.generateAnswerAnalysis({
          ...input,
          rangeEnd: '2026-08-09T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        caller.admin.generateAnswerAnalysis({ ...input, venueId: secondVenueId }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        Promise.all([
          db.answerAnalysisSnapshot.count({ where: { tenantId } }),
          db.generationRequestDispatch.count({ where: { tenantId } }),
          db.auditLog.count({ where: { tenantId } }),
        ]),
      ).resolves.toEqual(countsBefore)
    })

    it('replays the exact weekly report and rejects a changed title without writes', async () => {
      const caller = testRouter.createCaller(adminCtx())
      const requestId = randomUUID()
      const input = {
        tenantId,
        venueId,
        weekStart: rangeStart,
        weekEnd: rangeEnd,
        title: 'Weekly identity',
        requestId,
      }
      const created = await caller.admin.generateWeeklyReportDraft(input)
      expect(created).toMatchObject({ requestId, dispatchState: 'PENDING', replayed: false })
      await expect(caller.admin.generateWeeklyReportDraft(input)).resolves.toMatchObject({
        reportId: created.reportId,
        requestId,
        dispatchState: 'PENDING',
        replayed: true,
      })

      const countsBefore = await Promise.all([
        db.weeklyReport.count({ where: { tenantId } }),
        db.generationRequestDispatch.count({ where: { tenantId } }),
        db.auditLog.count({ where: { tenantId } }),
      ])
      await expect(
        caller.admin.generateWeeklyReportDraft({ ...input, title: 'Changed weekly identity' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        Promise.all([
          db.weeklyReport.count({ where: { tenantId } }),
          db.generationRequestDispatch.count({ where: { tenantId } }),
          db.auditLog.count({ where: { tenantId } }),
        ]),
      ).resolves.toEqual(countsBefore)
    })

    it('keeps the PENDING request durable when the best-effort kick fails', async () => {
      enqueueGenerationDispatchKick.mockRejectedValueOnce(new Error('synthetic kick failure'))
      const caller = testRouter.createCaller(adminCtx())
      const requestId = randomUUID()
      const result = await caller.admin.generateAnswerAnalysis({
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
        requestId,
      })
      expect(result).toMatchObject({ requestId, dispatchState: 'PENDING', replayed: false })
      await expect(
        db.generationRequestDispatch.findFirst({
          where: {
            tenantId,
            venueId,
            kind: 'ANSWER_ANALYSIS',
            requestId,
            recordId: result.snapshotId,
            status: 'PENDING',
          },
        }),
      ).resolves.not.toBeNull()
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.answer-analysis.dispatch-kick.failed' }),
      )
    })
  },
)
