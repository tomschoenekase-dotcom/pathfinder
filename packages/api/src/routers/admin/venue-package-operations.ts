import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { standaloneReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { runAdminReviewedDraftOrchestration } from '../../lib/admin-reviewed-draft-orchestration'
import {
  canonicalVenuePackagePayload,
  VenuePackagePayload,
  VenuePackageStoredPreview,
  VenuePackageValidationReport,
} from '../../schemas/venue-package'
import { adminProcedure } from '../../trpc'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()

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
  createReviewedVenuePackageDraft: adminProcedure
    .input(scope.extend({ draftKey: z.string().uuid(), payload: VenuePackagePayload }))
    .mutation(({ ctx, input }) =>
      runAdminReviewedDraftOrchestration({
        ctx,
        tenantId: input.tenantId,
        draft: { venueId: input.venueId, draftKey: input.draftKey, payload: input.payload },
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
        const payloadHash = createHash('sha256')
          .update(canonicalVenuePackagePayload(input.venueId, payload.data))
          .digest('hex')
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
        }
      }),
    ),
})
