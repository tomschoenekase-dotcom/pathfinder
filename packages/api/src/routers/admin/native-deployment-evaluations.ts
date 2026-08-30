import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { buildNativeContentReadSwitchContract } from '@pathfinder/contracts'
import {
  compareNativeContentShadowRuns,
  db,
  EvaluationRunComparisonError,
  NativeContentShadowComparisonError,
  NativeDeploymentEvaluationEvidenceError,
  measureNativeContentConvergenceAction,
  recordNativeDeploymentEvaluationEvidenceAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  NATIVE_EVALUATION_MAX_BUDGET_E8_USD,
  NATIVE_EVALUATION_MAX_CASES,
  requestNativeDeploymentEvaluation,
} from './native-deployment-evaluation-request'

const scope = z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }).strict()

export const adminNativeDeploymentEvaluationsRouter = router({
  listNativeContentShadowRuns: adminProcedure
    .input(scope.extend({ releaseId: z.string().uuid() }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const release = await db.nativeVenueDeploymentRelease.findFirst({
          where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        })
        if (!release)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Native release was not found.' })
        const runSelect = {
          id: true,
          contentSnapshotKind: true,
          createdAt: true,
          completedAt: true,
          modelProvider: true,
          modelName: true,
        } as const
        const [baselines, candidates] = await Promise.all([
          db.evalRun.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'COMPLETED',
              contentSnapshotKind: 'LEGACY_VENUE_CONTENT_V1',
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 50,
            select: runSelect,
          }),
          db.evalRun.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'COMPLETED',
              contentSnapshotKind: 'NATIVE_CORE_V1',
              contentSnapshotRef: release.id,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 50,
            select: runSelect,
          }),
        ])
        const safe = (row: (typeof baselines)[number]) => ({
          id: row.id,
          createdAt: row.createdAt,
          completedAt: row.completedAt,
          modelProvider: row.modelProvider,
          modelName: row.modelName,
        })
        return {
          baselines: baselines.map(safe),
          candidates: candidates.map(safe),
          bounded: true as const,
          advisoryOnly: true as const,
        }
      }),
    ),
  compareNativeContentShadowRuns: adminProcedure
    .input(
      scope
        .extend({
          releaseId: z.string().uuid(),
          baselineRunId: z.string().uuid(),
          candidateRunId: z.string().uuid(),
        })
        .strict()
        .refine((input) => input.baselineRunId !== input.candidateRunId, {
          message: 'Select different baseline and candidate runs.',
          path: ['candidateRunId'],
        }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const comparison = await compareNativeContentShadowRuns(input, db)
          const convergence = await measureNativeContentConvergenceAction(db, input)
          return {
            ...comparison,
            readSwitchContract: buildNativeContentReadSwitchContract({
              targetReleaseId: input.releaseId,
              convergence,
              shadowComparison: comparison,
            }),
          }
        } catch (error) {
          if (
            error instanceof NativeContentShadowComparisonError ||
            error instanceof EvaluationRunComparisonError
          )
            throw new TRPCError({
              code:
                error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'NOT_FOUND'
                    ? 'NOT_FOUND'
                    : 'PRECONDITION_FAILED',
              message: error.message,
            })
          throw error
        }
      }),
    ),
  requestNativeVenueDeploymentEvaluation: adminProcedure
    .input(
      scope
        .extend({
          releaseId: z.string().uuid(),
          expectedReleaseUpdatedAt: z.coerce.date(),
          operationId: z.string().uuid(),
          caseIds: z
            .array(z.string().uuid())
            .min(1)
            .max(NATIVE_EVALUATION_MAX_CASES)
            .refine((ids) => new Set(ids).size === ids.length),
          budgetCeilingE8Usd: z.string().regex(/^\d+$/u),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const budget = BigInt(input.budgetCeilingE8Usd)
      if (budget > NATIVE_EVALUATION_MAX_BUDGET_E8_USD)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Evaluation budget exceeds the limit' })
      return requestNativeDeploymentEvaluation({
        ...input,
        budgetCeilingE8Usd: budget,
        actorId: ctx.session.userId,
      })
    }),
  recordNativeVenueDeploymentEvaluationEvidence: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          releaseId: z.string().uuid(),
          runId: z.string().uuid(),
          operationId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const run = await db.evalRun.findFirst({
            where: {
              id: input.runId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              contentSnapshotKind: 'NATIVE_CORE_V1',
              contentSnapshotRef: input.releaseId,
            },
            select: { identityHash: true },
          })
          if (!run)
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Evaluation run was not found.' })
          return await recordNativeDeploymentEvaluationEvidenceAction(
            {
              ...input,
              expectedRunIdentityHash: run.identityHash,
              actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: ctx.session.userId },
            },
            db,
          )
        } catch (error) {
          if (error instanceof NativeDeploymentEvaluationEvidenceError)
            throw new TRPCError({
              code:
                error.code === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : error.code === 'CONFLICT'
                      ? 'CONFLICT'
                      : 'PRECONDITION_FAILED',
              message: error.message,
            })
          throw error
        }
      }),
    ),
  listNativeVenueDeploymentEvaluationEvidence: adminProcedure
    .input(
      scope
        .extend({
          releaseId: z.string().uuid(),
          cursor: z
            .object({ createdAt: z.coerce.date(), id: z.string().uuid() })
            .strict()
            .nullable()
            .default(null),
          limit: z.number().int().min(1).max(20).default(10),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const release = await db.nativeVenueDeploymentRelease.findFirst({
          where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        })
        if (!release)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Native deployment was not found.' })
        const rows = await db.nativeVenueDeploymentEvaluationEvidence.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            releaseId: input.releaseId,
            ...(input.cursor
              ? {
                  OR: [
                    { createdAt: { lt: input.cursor.createdAt } },
                    { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
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
        })
        const items = rows.slice(0, input.limit).map((item) => ({
          ...item,
          totalCostE8Usd: item.totalCostE8Usd.toString(),
          advisoryOnly: true as const,
        }))
        const last = items.at(-1)
        return {
          items,
          hasMore: rows.length > input.limit,
          nextCursor:
            rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
        }
      }),
    ),
})
