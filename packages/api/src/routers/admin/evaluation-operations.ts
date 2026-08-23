import { z } from 'zod'
import { env } from '@pathfinder/config'
import {
  compareEvaluationRuns,
  db,
  EvaluationRunComparisonError,
  getEvaluationRegressionAlertPolicy,
  isEvaluationRuntimeDurablyEnabled,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { adminEvaluationOperationActionsRouter } from './evaluation-operation-actions'
import { adminEvaluationConversationCasesRouter } from './evaluation-conversation-cases'
import { adminEvaluationOnboardingReadsRouter } from './evaluation-onboarding-reads'
import { adminEvaluationReviewActionsRouter } from './evaluation-review-actions'

const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 50
const MAX_RUN_CASES = 50
const MAX_RUN_BUDGET_E8_USD = 100_000_000n
const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'

const inputSchema = z.object({
  tenantId: z.string().min(1),
  venueId: z.string().min(1),
  cursor: z
    .object({
      createdAt: z.string().datetime(),
      id: z.string().uuid(),
    })
    .optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
})

const caseListInputSchema = z.object({
  tenantId: z.string().min(1),
  venueId: z.string().min(1),
  cursor: z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
})

const comparisonInputSchema = z
  .object({
    tenantId: z.string().min(1),
    venueId: z.string().min(1),
    baselineRunId: z.string().uuid(),
    candidateRunId: z.string().uuid(),
  })
  .refine((input) => input.baselineRunId !== input.candidateRunId, {
    message: 'Select two different evaluation runs',
    path: ['candidateRunId'],
  })

type OutcomeCount = {
  runId: string
  outcome: 'SCORED' | 'OPERATIONAL_FAILURE' | 'ADMISSION_DEFERRED' | 'BUDGET_BLOCKED' | 'CANCELLED'
  passed: boolean | null
  _count: { _all: number }
}

function summarizeOutcomes(rows: OutcomeCount[]) {
  const summaryByRun = new Map<
    string,
    {
      resultCount: number
      quality: { scored: number; passed: number; failed: number }
      operational: { failures: number; deferred: number; budgetBlocked: number; cancelled: number }
    }
  >()

  for (const row of rows) {
    const summary = summaryByRun.get(row.runId) ?? {
      resultCount: 0,
      quality: { scored: 0, passed: 0, failed: 0 },
      operational: { failures: 0, deferred: 0, budgetBlocked: 0, cancelled: 0 },
    }
    const count = row._count._all
    summary.resultCount += count
    if (row.outcome === 'SCORED') {
      summary.quality.scored += count
      if (row.passed === true) summary.quality.passed += count
      if (row.passed === false) summary.quality.failed += count
    } else if (row.outcome === 'OPERATIONAL_FAILURE') {
      summary.operational.failures += count
    } else if (row.outcome === 'ADMISSION_DEFERRED') {
      summary.operational.deferred += count
    } else if (row.outcome === 'BUDGET_BLOCKED') {
      summary.operational.budgetBlocked += count
    } else {
      summary.operational.cancelled += count
    }
    summaryByRun.set(row.runId, summary)
  }

  return summaryByRun
}

/**
 * Read-only evaluation evidence for the internal admin console. This intentionally
 * omits case, observation, model, and run-config snapshots. A future snapshot reveal
 * needs a separate privacy and authorization review.
 */
const adminEvaluationOperationReadsRouter = router({
  compareEvaluationRuns: adminProcedure.input(comparisonInputSchema).query(async ({ input }) => {
    try {
      return await withTenantIsolationBypass(() => compareEvaluationRuns(input, db))
    } catch (error) {
      if (error instanceof EvaluationRunComparisonError)
        throw new TRPCError({
          code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : 'NOT_FOUND',
          message: error.message,
        })
      throw error
    }
  }),
  listEvaluationCases: adminProcedure.input(caseListInputSchema).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const [rows, flag, durableGlobalEnabled, regressionAlertPolicy] = await Promise.all([
        db.evalCase.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.cursor
              ? {
                  AND: [
                    {
                      OR: [
                        { createdAt: { lt: cursorDate! } },
                        { createdAt: cursorDate!, id: { lt: input.cursor.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            caseKey: true,
            revision: true,
            category: true,
            schemaVersion: true,
            sourceType: true,
            sourceRef: true,
            createdAt: true,
          },
        }),
        db.tenantFeatureFlag.findUnique({
          where: {
            tenantId_flagKey: { tenantId: input.tenantId, flagKey: EVALUATION_RUNNER_FLAG },
          },
          select: { enabled: true },
        }),
        isEvaluationRuntimeDurablyEnabled(db),
        getEvaluationRegressionAlertPolicy(db),
      ])
      const hasMore = rows.length > input.limit
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        runnerEnabled:
          env.EVALUATION_RUNNER_ENABLED && durableGlobalEnabled && flag?.enabled === true,
        readiness: {
          apiProcessEnabled: env.EVALUATION_RUNNER_ENABLED,
          durableGlobalEnabled,
          tenantEnabled: flag?.enabled === true,
        },
        regressionAlerts: regressionAlertPolicy
          ? {
              configured: true as const,
              minimumPassRateDrop: regressionAlertPolicy.minimumPassRateDrop,
              errorPassRateDrop: regressionAlertPolicy.errorPassRateDrop,
            }
          : {
              configured: false as const,
              minimumPassRateDrop: null,
              errorPassRateDrop: null,
            },
        maximumCases: MAX_RUN_CASES,
        maximumBudgetE8Usd: MAX_RUN_BUDGET_E8_USD.toString(),
        nextCursor:
          hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      }
    }),
  ),
  listEvaluationRuns: adminProcedure.input(inputSchema).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const runs = await db.evalRun.findMany({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          ...(input.cursor
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { lt: cursorDate! } },
                      { createdAt: cursorDate!, id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          identityHash: true,
          corpusHash: true,
          promptContractVersion: true,
          promptContractHash: true,
          packageSnapshotRef: true,
          packageSnapshotHash: true,
          contentSnapshotVersion: true,
          contentSnapshotHash: true,
          modelProvider: true,
          modelName: true,
          modelSnapshotHash: true,
          declaredBudgetCeilingE8Usd: true,
          createdBy: true,
          triggerType: true,
          status: true,
          attemptNumber: true,
          maxAttempts: true,
          startedAt: true,
          completedAt: true,
          cancellationRequestedAt: true,
          lastErrorCode: true,
          createdAt: true,
        },
      })

      const hasMore = runs.length > input.limit
      const pageRuns = runs.slice(0, input.limit)
      const runIds = pageRuns.map((run) => run.id)
      if (runIds.length === 0)
        return { items: [], humanConclusions: [], failedCases: [], nextCursor: null }

      const [outcomeCounts, humanConclusions, failedCaseRows] = await Promise.all([
        db.evalResult.groupBy({
          by: ['runId', 'outcome', 'passed'],
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: { in: runIds },
          },
          _count: { _all: true },
        }),
        db.evalReview.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            result: { runId: { in: runIds } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: {
            id: true,
            resultId: true,
            reviewerId: true,
            conclusion: true,
            decision: true,
            rubricVersion: true,
            revision: true,
            createdAt: true,
            result: {
              select: {
                runId: true,
                caseRevision: true,
                evalCase: { select: { caseKey: true, category: true } },
              },
            },
          },
        }),
        db.evalResult.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: { in: runIds },
            outcome: 'SCORED',
            passed: false,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
          select: {
            id: true,
            runId: true,
            caseRevision: true,
            passedChecks: true,
            totalChecks: true,
            checksSnapshot: true,
            evalCase: { select: { id: true, caseKey: true, category: true } },
          },
        }),
      ])

      const summaries = summarizeOutcomes(outcomeCounts)
      const emptySummary = () => ({
        resultCount: 0,
        quality: { scored: 0, passed: 0, failed: 0 },
        operational: { failures: 0, deferred: 0, budgetBlocked: 0, cancelled: 0 },
      })
      const last = pageRuns.at(-1)

      return {
        items: pageRuns.map((run) => ({
          ...run,
          summary: summaries.get(run.id) ?? emptySummary(),
        })),
        humanConclusions,
        failedCases: failedCaseRows.map((row) => ({
          id: row.id,
          runId: row.runId,
          caseId: row.evalCase.id,
          caseKey: row.evalCase.caseKey,
          category: row.evalCase.category,
          caseRevision: row.caseRevision,
          passedChecks: row.passedChecks,
          totalChecks: row.totalChecks,
          checks: Array.isArray(row.checksSnapshot)
            ? row.checksSnapshot.flatMap((check) => {
                if (
                  !check ||
                  typeof check !== 'object' ||
                  !('checkId' in check) ||
                  typeof check.checkId !== 'string' ||
                  !('passed' in check) ||
                  typeof check.passed !== 'boolean' ||
                  !('detail' in check) ||
                  typeof check.detail !== 'string'
                )
                  return []
                return [
                  {
                    checkId: check.checkId.slice(0, 120),
                    passed: check.passed,
                    detail: check.detail.slice(0, 500),
                  },
                ]
              })
            : [],
        })),
        nextCursor:
          hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      }
    }),
  ),
})

export const adminEvaluationOperationsRouter = mergeRouters(
  adminEvaluationOnboardingReadsRouter,
  adminEvaluationOperationReadsRouter,
  adminEvaluationOperationActionsRouter,
  adminEvaluationConversationCasesRouter,
  adminEvaluationReviewActionsRouter,
)
