import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  FinalizeOffboardingExportInput,
  OffboardingExportFinalizationProjection,
  OffboardingExportFinalizationResult,
  OffboardingExportReviewResult,
} from '@pathfinder/contracts/offboarding-export-finalization'
import {
  finalizeOffboardingExportAction,
  OffboardingExportFinalizationError,
  reviewOffboardingPlanForExportAction,
  type FrozenOffboardingExportManifest,
  resolveEffectivePublishedUniversalContent,
} from '@pathfinder/db'

import { router } from '../../core'
import { createOffboardingExportStorage } from '../../lib/offboarding-export-storage'
import { adminProcedure } from '../../trpc'

/* Prisma transaction clients are structurally typed but do not expose a stable public inferred type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManifestDb = any

function mapError(error: unknown): never {
  if (error instanceof OffboardingExportFinalizationError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}

async function buildManifest(
  db: ManifestDb,
  input: {
    tenantId: string
    planId: string
    venueId: string
    kind: FrozenOffboardingExportManifest['kind']
  },
): Promise<FrozenOffboardingExportManifest> {
  const scope = { tenantId: input.tenantId, venueId: input.venueId }
  let rows: Array<{ id: string; version: string; recordedAt: string }> = []
  let available = 0
  if (input.kind === 'APPROVED_CONTENT') {
    const [places, knowledge, published] = await Promise.all([
      db.place.findMany({
        where: { ...scope, isActive: true },
        orderBy: { id: 'asc' },
        take: 501,
        select: { id: true, updatedAt: true },
      }),
      db.venueKnowledgeEntry.findMany({
        where: { ...scope, isEnabled: true },
        orderBy: { id: 'asc' },
        take: 501,
        select: { id: true, updatedAt: true },
      }),
      resolveEffectivePublishedUniversalContent({
        db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        maximumModules: 100,
      }),
    ])
    const publishedRevisions = published.length
      ? await db.contentModuleRevision.findMany({
          where: { ...scope, id: { in: published.map((row) => row.revisionId) } },
          select: { id: true, createdAt: true },
        })
      : []
    const publishedCreatedAt = new Map<string, Date>(
      publishedRevisions.map((row: { id: string; createdAt: Date }) => [row.id, row.createdAt]),
    )
    if (publishedCreatedAt.size !== published.length)
      throw new OffboardingExportFinalizationError(
        'INCOMPLETE',
        'Published content evidence is inconsistent',
      )
    if (places.length > 500 || knowledge.length > 500)
      throw new OffboardingExportFinalizationError(
        'INCOMPLETE',
        'Approved content exceeds safe bounds',
      )
    rows = [
      ...places.map((row: { id: string; updatedAt: Date }) => ({
        id: row.id,
        version: row.updatedAt.toISOString(),
        recordedAt: row.updatedAt.toISOString(),
      })),
      ...knowledge.map((row: { id: string; updatedAt: Date }) => ({
        id: row.id,
        version: row.updatedAt.toISOString(),
        recordedAt: row.updatedAt.toISOString(),
      })),
      ...published.map((row) => ({
        id: row.revisionId,
        version: String(row.version),
        recordedAt: publishedCreatedAt.get(row.revisionId)!.toISOString(),
      })),
    ]
    available = rows.length
  } else if (input.kind === 'CONTENT_HISTORY') {
    const found = await db.contentVersion.findMany({
      where: scope,
      orderBy: [{ sequence: 'asc' }],
      take: 2001,
      select: { id: true, sequence: true, createdAt: true },
    })
    available = found.length
    rows = found.slice(0, 2000).map((row: { id: string; sequence: bigint; createdAt: Date }) => ({
      id: row.id,
      version: String(row.sequence),
      recordedAt: row.createdAt.toISOString(),
    }))
  } else if (input.kind === 'VENUE_PACKAGES') {
    const found = await db.venuePackage.findMany({
      where: scope,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 501,
      select: { id: true, schemaVersion: true, createdAt: true },
    })
    available = found.length
    rows = found
      .slice(0, 500)
      .map((row: { id: string; schemaVersion: number; createdAt: Date }) => ({
        id: row.id,
        version: String(row.schemaVersion),
        recordedAt: row.createdAt.toISOString(),
      }))
  } else if (input.kind === 'CONFIGURATION') {
    const venue = await db.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true, updatedAt: true },
    })
    if (!venue)
      throw new OffboardingExportFinalizationError('NOT_FOUND', 'Venue configuration was not found')
    available = 1
    rows = [
      {
        id: venue.id,
        version: venue.updatedAt.toISOString(),
        recordedAt: venue.updatedAt.toISOString(),
      },
    ]
  } else {
    const found = await db.auditLog.findMany({
      where: { tenantId: input.tenantId, targetId: input.venueId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 2001,
      select: { id: true, action: true, createdAt: true },
    })
    available = found.length
    rows = found.slice(0, 2000).map((row: { id: string; action: string; createdAt: Date }) => ({
      id: row.id,
      version: row.action,
      recordedAt: row.createdAt.toISOString(),
    }))
  }
  if (available > rows.length)
    throw new OffboardingExportFinalizationError(
      'INCOMPLETE',
      'The bounded export source is incomplete',
    )
  const classifications = {
    APPROVED_CONTENT: 'APPROVED_PUBLIC',
    CONTENT_HISTORY: 'CLIENT_HISTORY',
    VENUE_PACKAGES: 'PACKAGE_EVIDENCE',
    CONFIGURATION: 'SAFE_CONFIGURATION',
    AUDIT_HISTORY: 'DIRECT_VENUE_AUDIT_REFERENCE',
  } as const
  return {
    schemaVersion: 1,
    privacyBoundary: 'BOUNDED_EXPORT_EVIDENCE',
    ...input,
    records: rows.map((row) => ({
      ...row,
      classification: classifications[input.kind as keyof typeof classifications],
    })),
    recordCount: rows.length,
    sourceComplete: true,
  }
}

export const adminOffboardingExportFinalizationRouter = router({
  getOffboardingExportFinalization: adminProcedure
    .input(z.object({ tenantId: z.string().min(1), planId: z.string().min(1) }).strict())
    .output(OffboardingExportFinalizationProjection)
    .query(async ({ ctx, input }) => {
      const plan = await ctx.db.offboardingPlan.findFirst({
        where: { id: input.planId, tenantId: input.tenantId },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          exportKinds: true,
          venueTargets: {
            orderBy: [{ venueId: 'asc' }],
            select: {
              venueId: true,
              exportArtifacts: {
                where: { operationId: { not: null } },
                select: { kind: true },
              },
            },
          },
        },
      })
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Offboarding plan not found' })
      if (!['REQUESTED', 'REVIEWED', 'EXPORT_READY', 'CANCELLED'].includes(plan.status)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Export finalization is unavailable for this plan state',
        })
      }
      const targets = plan.venueTargets.map((target) => {
        const recorded = new Set(target.exportArtifacts.map(({ kind }) => kind))
        return {
          venueId: target.venueId,
          remainingExportKinds: plan.exportKinds.filter((kind) => !recorded.has(kind)),
        }
      })
      const remainingArtifacts = targets.reduce(
        (count, target) => count + target.remainingExportKinds.length,
        0,
      )
      const hasMatrix = plan.venueTargets.length > 0 && plan.exportKinds.length > 0
      return {
        planId: plan.id,
        status: plan.status as 'REQUESTED' | 'REVIEWED' | 'EXPORT_READY' | 'CANCELLED',
        expectedUpdatedAt: plan.updatedAt.toISOString(),
        remainingArtifacts,
        exportActions: {
          review: {
            allowed: plan.status === 'REQUESTED' && hasMatrix,
            reason:
              plan.status !== 'REQUESTED'
                ? 'This plan is no longer awaiting export review.'
                : hasMatrix
                  ? 'Review the declared non-deleting export matrix.'
                  : 'At least one venue and export kind are required.',
          },
          finalize: {
            allowed: plan.status === 'REVIEWED' && remainingArtifacts > 0,
            reason:
              plan.status !== 'REVIEWED'
                ? 'Finalize is available only for an exactly reviewed plan.'
                : remainingArtifacts > 0
                  ? 'Generate one remaining non-deleting export artifact.'
                  : 'Every declared export artifact is already recorded.',
          },
        },
        targets,
      }
    }),
  reviewOffboardingPlanExports: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          planId: z.string().min(1),
          operationId: z.string().uuid(),
          expectedUpdatedAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    )
    .output(OffboardingExportReviewResult)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await reviewOffboardingPlanForExportAction(
          {
            ...input,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          ctx.db,
        )
        return {
          planId: result.planId,
          status: result.status,
          expectedUpdatedAt: result.updatedAt.toISOString(),
          replayed: result.replayed,
        }
      } catch (error) {
        mapError(error)
      }
    }),
  finalizeOffboardingExportArtifact: adminProcedure
    .input(FinalizeOffboardingExportInput)
    .output(OffboardingExportFinalizationResult)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await finalizeOffboardingExportAction(
          {
            ...input,
            expectedPlanUpdatedAt: new Date(input.expectedPlanUpdatedAt),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          },
          {
            client: ctx.db,
            buildManifest: (scope) =>
              ctx.db.$transaction((tx) => buildManifest(tx, scope), {
                isolationLevel: 'RepeatableRead',
              }),
            storage: createOffboardingExportStorage(),
          },
        )
        return { ...result, planUpdatedAt: result.planUpdatedAt.toISOString() }
      } catch (error) {
        mapError(error)
      }
    }),
})
