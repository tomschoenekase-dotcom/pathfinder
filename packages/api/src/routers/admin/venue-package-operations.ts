import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { standaloneReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { venuePackagePayloadHash } from '../../lib/venue-package-identity'
import { createVenuePackageDraftService } from '../venue-package'
import {
  VenuePackagePayload,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
} from '../../schemas/venue-package'
import { adminProcedure } from '../../trpc'
import { withContentVersionActor } from '../../middleware/content-version-actor'
import {
  applyVenuePackageLifecycle,
  approveVenuePackageLifecycle,
  revertVenuePackageLifecycle,
} from '../../lib/venue-package-core'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()
const lifecycleInput = scope.extend({
  id: z.string().min(1).max(191),
  expectedUpdatedAt: z.coerce.date(),
  commandKey: z.string().uuid(),
})

function platformAdminActor(userId: string) {
  return { type: 'HUMAN', id: userId, role: 'PLATFORM_ADMIN' } as const
}

const summarySelect = {
  id: true,
  schemaVersion: true,
  payloadHash: true,
  baseDigest: true,
  validationReport: true,
  status: true,
  approvedAt: true,
  appliedAt: true,
  revertedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

type SummaryRow = {
  id: string
  schemaVersion: number
  payloadHash: string
  baseDigest: string
  validationReport: unknown
  status: string
  approvedAt: Date | null
  appliedAt: Date | null
  revertedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function parseSummary(row: SummaryRow) {
  const report = VenuePackageValidationReport.safeParse(row.validationReport)
  if (!report.success) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Stored venue-package validation evidence is unavailable.',
    })
  }
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    payloadHash: row.payloadHash,
    baseDigest: row.baseDigest,
    status: row.status,
    approvedAt: row.approvedAt,
    appliedAt: row.appliedAt,
    revertedAt: row.revertedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    errorCount: report.data.errors.length,
    warningCount: report.data.warnings.length,
    semanticStatus: report.data.semanticDuplicateScan.status,
  }
}

export const adminVenuePackageOperationsRouter = router({
  approveVenuePackage: adminProcedure
    .input(
      lifecycleInput.extend({
        acknowledgedWarningDigest: z.string().regex(/^[a-f0-9]{64}$/),
        acknowledgedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .mutation(({ ctx, input }) =>
      approveVenuePackageLifecycle({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        actor: platformAdminActor(ctx.session.userId),
        command: input,
      }),
    ),

  applyVenuePackage: adminProcedure
    .use(withContentVersionActor)
    .input(lifecycleInput)
    .mutation(({ ctx, input }) =>
      applyVenuePackageLifecycle({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        actor: platformAdminActor(ctx.session.userId),
        command: input,
      }),
    ),

  revertVenuePackage: adminProcedure
    .use(withContentVersionActor)
    .input(lifecycleInput)
    .mutation(({ ctx, input }) =>
      revertVenuePackageLifecycle({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        actor: platformAdminActor(ctx.session.userId),
        command: input,
      }),
    ),

  createReviewedVenuePackageDraft: adminProcedure
    .input(scope.extend({ draftKey: z.string().uuid(), payload: VenuePackagePayload }))
    .mutation(({ ctx, input }) =>
      createVenuePackageDraftService({
        db: ctx.db,
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: { venueId: input.venueId, draftKey: input.draftKey, payload: input.payload },
        finalizer: standaloneReviewedDraftFinalizer(ctx.session.userId),
      }),
    ),

  listVenuePackagesForReview: adminProcedure
    .input(
      scope
        .extend({
          limit: z.number().int().min(1).max(50).default(25),
          cursorAt: z.string().datetime().optional(),
          cursorId: z.string().min(1).max(191).optional(),
        })
        .refine((value) => Boolean(value.cursorAt) === Boolean(value.cursorId), {
          message: 'Package cursor fields must be supplied together.',
        }),
    )
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        const cursorAt = input.cursorAt ? new Date(input.cursorAt) : null
        const rows = await db.venuePackage.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(cursorAt && input.cursorId
              ? {
                  OR: [
                    { createdAt: { lt: cursorAt } },
                    { createdAt: cursorAt, id: { lt: input.cursorId } },
                  ],
                }
              : {}),
          },
          select: summarySelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
        const hasMore = rows.length > input.limit
        const items = rows.slice(0, input.limit).map(parseSummary)
        const tail = hasMore ? items.at(-1) : null
        return {
          items,
          nextCursor: tail
            ? { createdAt: (tail.createdAt as Date).toISOString(), id: tail.id as string }
            : null,
        }
      }),
    ),

  getVenuePackageForReview: adminProcedure
    .input(scope.extend({ packageId: z.string().min(1).max(191) }))
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        const row = await db.venuePackage.findFirst({
          where: {
            id: input.packageId,
            tenantId: input.tenantId,
            venueId: input.venueId,
          },
          select: {
            ...summarySelect,
            payload: true,
            previewPlan: true,
            supportHandoffs: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                id: true,
                requestVersion: true,
                createdAt: true,
                supportRequest: {
                  select: {
                    id: true,
                    subject: true,
                    status: true,
                    clientVersion: true,
                  },
                },
              },
            },
          },
        })
        if (!row) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found' })
        }
        const preview = VenuePackageStoredPreview.safeParse(row.previewPlan)
        const report = VenuePackageValidationReport.safeParse(row.validationReport)
        const payload = VenuePackagePayload.safeParse(row.payload)
        if (!preview.success || !report.success || !payload.success) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stored venue-package review evidence is unavailable.',
          })
        }
        const payloadHash = venuePackagePayloadHash(input.venueId, payload.data)
        const warningDigest = createHash('sha256')
          .update(JSON.stringify(report.data.warnings))
          .digest('hex')
        if (
          payloadHash !== row.payloadHash ||
          payload.data.schemaVersion !== row.schemaVersion ||
          preview.data.schemaVersion !== row.schemaVersion ||
          preview.data.payloadHash !== row.payloadHash ||
          preview.data.baseDigest !== row.baseDigest ||
          preview.data.warningDigest !== warningDigest ||
          JSON.stringify(preview.data.report) !== JSON.stringify(report.data)
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Stored venue-package review evidence does not match its immutable identity.',
          })
        }
        const evaluationRuns = await db.evalRun.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            contentSnapshotRef: row.id,
            contentSnapshotKind: {
              in: ['REVIEWABLE_VENUE_PACKAGE_V1', 'APPROVED_VENUE_PACKAGE_V1'],
            },
            packageSnapshotHash: row.payloadHash,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
          select: {
            id: true,
            identityHash: true,
            contentSnapshotKind: true,
            contentSnapshotHash: true,
            modelProvider: true,
            modelName: true,
            status: true,
            declaredBudgetCeilingE8Usd: true,
            budgetAccountedE8Usd: true,
            startedAt: true,
            completedAt: true,
            lastErrorCode: true,
            createdAt: true,
          },
        })
        const boundedRuns = evaluationRuns.slice(0, 20)
        const outcomeRows =
          boundedRuns.length === 0
            ? []
            : await db.evalResult.groupBy({
                by: ['runId', 'outcome', 'passed'],
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  runId: { in: boundedRuns.map((run) => run.id) },
                },
                _count: { _all: true },
              })
        const countsByRun = new Map<
          string,
          {
            scored: number
            passed: number
            failed: number
            operationalFailures: number
            deferred: number
            budgetBlocked: number
            cancelled: number
          }
        >()
        for (const outcome of outcomeRows) {
          const counts = countsByRun.get(outcome.runId) ?? {
            scored: 0,
            passed: 0,
            failed: 0,
            operationalFailures: 0,
            deferred: 0,
            budgetBlocked: 0,
            cancelled: 0,
          }
          const count = outcome._count._all
          if (outcome.outcome === 'SCORED') {
            counts.scored += count
            if (outcome.passed === true) counts.passed += count
            if (outcome.passed === false) counts.failed += count
          } else if (outcome.outcome === 'OPERATIONAL_FAILURE') {
            counts.operationalFailures += count
          } else if (outcome.outcome === 'ADMISSION_DEFERRED') {
            counts.deferred += count
          } else if (outcome.outcome === 'BUDGET_BLOCKED') {
            counts.budgetBlocked += count
          } else {
            counts.cancelled += count
          }
          countsByRun.set(outcome.runId, counts)
        }
        const emptyCounts = () => ({
          scored: 0,
          passed: 0,
          failed: 0,
          operationalFailures: 0,
          deferred: 0,
          budgetBlocked: 0,
          cancelled: 0,
        })
        const supportHandoff = row.supportHandoffs[0]
        return {
          id: row.id,
          schemaVersion: row.schemaVersion,
          payloadHash: row.payloadHash,
          baseDigest: row.baseDigest,
          status: row.status,
          approvedAt: row.approvedAt,
          appliedAt: row.appliedAt,
          revertedAt: row.revertedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          payload: payload.data,
          validationReport: report.data,
          previewPlan: preview.data,
          supportContext: supportHandoff
            ? {
                handoffId: supportHandoff.id,
                linkedAt: supportHandoff.createdAt,
                requestVersion: supportHandoff.requestVersion,
                request: supportHandoff.supportRequest,
              }
            : null,
          evaluationEvidence: {
            exactPackage: {
              id: row.id,
              payloadHash: row.payloadHash,
              baseDigest: row.baseDigest,
            },
            truncated: evaluationRuns.length > 20,
            runs: boundedRuns.map((run) => ({
              ...run,
              declaredBudgetCeilingE8Usd: run.declaredBudgetCeilingE8Usd.toString(),
              budgetAccountedE8Usd: run.budgetAccountedE8Usd.toString(),
              outcomes: countsByRun.get(run.id) ?? emptyCounts(),
            })),
          },
        }
      }),
    ),
})
