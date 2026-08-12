import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  applyNativeVenueDeploymentAction,
  approveNativeVenueDeploymentAction,
  createNativeVenueDeploymentAction,
  db,
  projectNativeVenueStateAction,
  revertNativeVenueDeploymentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  actionGates,
  coverage,
  impactSummary,
  mapError,
  type NativeStatus,
  releaseSummary,
  safeLifecycleResult,
} from './native-venue-deployment-projections'
import { nativeEvaluationAvailability } from './native-deployment-evaluation-request'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()
const lifecycle = scope
  .extend({
    releaseId: z.string().uuid(),
    commandId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict()
function actor(userId: string) {
  return { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: userId }
}

export const adminNativeVenueDeploymentsRouter = router({
  listNativeVenueDeployments: adminProcedure
    .input(
      scope
        .extend({
          cursor: z.string().uuid().nullable().default(null),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [rows, head] = await Promise.all([
          db.nativeVenueDeploymentRelease.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
            take: input.limit + 1,
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              profile: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          db.nativeVenueDeploymentHead.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            select: { releaseId: true },
          }),
        ])
        return {
          items: rows
            .slice(0, input.limit)
            .map((row) => releaseSummary(row, head?.releaseId ?? null)),
          nextCursor: rows.length > input.limit ? (rows[input.limit - 1]?.id ?? null) : null,
        }
      }),
    ),
  getNativeVenueDeployment: adminProcedure
    .input(
      scope
        .extend({
          releaseId: z.string().uuid(),
          issueCursor: z.number().int().nonnegative().default(0),
          issueLimit: z.number().int().min(1).max(50).default(20),
          evaluationCursor: z
            .object({ createdAt: z.coerce.date(), id: z.string().uuid() })
            .strict()
            .nullable()
            .default(null),
          evaluationLimit: z.number().int().min(1).max(20).default(10),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const [row, head, latestEvaluation] = await Promise.all([
          db.nativeVenueDeploymentRelease.findFirst({
            where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              profile: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              approvedAt: true,
              appliedAt: true,
              revertedAt: true,
              expectedEffectCount: true,
              plan: true,
              evaluationEvidence: {
                ...(input.evaluationCursor
                  ? {
                      where: {
                        OR: [
                          { createdAt: { lt: input.evaluationCursor.createdAt } },
                          {
                            createdAt: input.evaluationCursor.createdAt,
                            id: { lt: input.evaluationCursor.id },
                          },
                        ],
                      },
                    }
                  : {}),
                orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
                take: input.evaluationLimit + 1,
                select: {
                  id: true,
                  runId: true,
                  disposition: true,
                  manifestCaseCount: true,
                  scoredCaseCount: true,
                  passedCaseCount: true,
                  failedCaseCount: true,
                  operationalFailureCount: true,
                  totalLatencyMs: true,
                  totalCostE8Usd: true,
                  runCompletedAt: true,
                  createdAt: true,
                },
              },
              _count: { select: { effects: true, commands: true, evaluationEvidence: true } },
            },
          }),
          db.nativeVenueDeploymentHead.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            select: { releaseId: true },
          }),
          db.nativeVenueDeploymentEvaluationEvidence.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId, releaseId: input.releaseId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { disposition: true, createdAt: true },
          }),
        ])
        if (!row)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Native deployment was not found.' })
        const impacts = impactSummary(row.plan)
        const status = row.status as NativeStatus
        return {
          id: row.id,
          tenantId: row.tenantId,
          venueId: row.venueId,
          profile: row.profile,
          status,
          version: row.updatedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          approvedAt: row.approvedAt,
          appliedAt: row.appliedAt,
          revertedAt: row.revertedAt,
          coverage,
          materializable: true,
          unsupported: false,
          issues: [],
          issueCount: 0,
          nextIssueCursor: null,
          impactSummary: impacts,
          effectSummary: {
            expected: row.expectedEffectCount,
            recorded: row._count.effects,
            byKind: impacts,
          },
          commandCount: row._count.commands,
          evaluationEvidence: {
            items: row.evaluationEvidence.slice(0, input.evaluationLimit).map((item) => ({
              ...item,
              totalCostE8Usd: item.totalCostE8Usd.toString(),
              advisoryOnly: true as const,
            })),
            totalCount: row._count.evaluationEvidence,
            hasMore: row.evaluationEvidence.length > input.evaluationLimit,
            nextCursor: (() => {
              if (row.evaluationEvidence.length <= input.evaluationLimit) return null
              const last = row.evaluationEvidence[input.evaluationLimit - 1]
              return last ? { createdAt: last.createdAt, id: last.id } : null
            })(),
            latest: latestEvaluation,
          },
          evaluationRunner: nativeEvaluationAvailability(),
          allowedActions: actionGates(status, row.updatedAt, row.id, head?.releaseId ?? null),
        }
      }),
    ),
  projectNativeVenueDeployment: adminProcedure.input(scope).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return await projectNativeVenueStateAction(db, input)
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  createNativeVenueDeployment: adminProcedure
    .input(scope.extend({ manifestJson: z.string().min(2).max(2_000_000) }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          let manifest: unknown
          try {
            manifest = JSON.parse(input.manifestJson) as unknown
          } catch {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Manifest text is not valid JSON.',
            })
          }
          const release = await createNativeVenueDeploymentAction(
            {
              ...input,
              manifest,
              actor: actor(ctx.session.userId),
            },
            db,
          )
          return releaseSummary(release)
        } catch (error) {
          mapError(error)
        }
      }),
    ),
  approveNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await approveNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  applyNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await applyNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
  revertNativeVenueDeployment: adminProcedure.input(lifecycle).mutation(({ ctx, input }) =>
    withTenantIsolationBypass(async () => {
      try {
        return safeLifecycleResult(
          await revertNativeVenueDeploymentAction(
            { ...input, actor: actor(ctx.session.userId) },
            db,
          ),
          input,
        )
      } catch (error) {
        mapError(error)
      }
    }),
  ),
})
