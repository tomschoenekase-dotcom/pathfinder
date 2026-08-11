import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import {
  createOrReplayEvaluationRun,
  createVenueContentSnapshot,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueEvaluationRun } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

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
export const adminEvaluationOperationsRouter = router({
  listEvaluationCases: adminProcedure.input(caseListInputSchema).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const cursorDate = input.cursor ? new Date(input.cursor.createdAt) : null
      const [rows, flag] = await Promise.all([
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
            createdAt: true,
          },
        }),
        db.tenantFeatureFlag.findUnique({
          where: {
            tenantId_flagKey: { tenantId: input.tenantId, flagKey: EVALUATION_RUNNER_FLAG },
          },
          select: { enabled: true },
        }),
      ])
      const hasMore = rows.length > input.limit
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        runnerEnabled: flag?.enabled ?? false,
        maximumCases: MAX_RUN_CASES,
        maximumBudgetE8Usd: MAX_RUN_BUDGET_E8_USD.toString(),
        nextCursor:
          hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      }
    }),
  ),
  requestEvaluationRun: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        idempotencyKey: z.string().trim().min(1).max(191),
        caseIds: z
          .array(z.string().uuid())
          .min(1)
          .max(MAX_RUN_CASES)
          .refine((ids) => new Set(ids).size === ids.length, 'Evaluation cases must be unique'),
        budgetCeilingE8Usd: z.string().regex(/^\d+$/u),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const budget = BigInt(input.budgetCeilingE8Usd)
      if (budget > MAX_RUN_BUDGET_E8_USD)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Evaluation run budget exceeds the admin hard limit',
        })
      const frozen = await withTenantIsolationBypass(async () => {
        return db.$transaction(async (tx) => {
          const [snapshot, cases, flag] = await Promise.all([
            createVenueContentSnapshot({
              db: tx,
              tenantId: input.tenantId,
              venueId: input.venueId,
            }),
            tx.evalCase.findMany({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                id: { in: input.caseIds },
              },
              select: { id: true, revision: true, caseHash: true },
            }),
            tx.tenantFeatureFlag.findUnique({
              where: {
                tenantId_flagKey: { tenantId: input.tenantId, flagKey: EVALUATION_RUNNER_FLAG },
              },
              select: { enabled: true },
            }),
          ])
          if (cases.length !== input.caseIds.length)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'One or more evaluation cases were not found in the requested venue',
            })
          const byId = new Map(cases.map((item) => [item.id, item]))
          const manifest = input.caseIds.map((caseId) => {
            const item = byId.get(caseId)!
            return { caseId: item.id, revision: item.revision, caseHash: item.caseHash }
          })
          const model = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
          const created = await createOrReplayEvaluationRun({
            db: tx,
            runId: randomUUID(),
            identity: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              idempotencyKey: input.idempotencyKey,
              caseManifest: manifest,
              promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
              promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
              packageSnapshotRef: null,
              packageSnapshotHash: null,
              contentSnapshotVersion: snapshot.contentVersion,
              contentSnapshotHash: snapshot.hash,
              modelProvider: model.provider,
              modelName: model.model,
              modelSnapshot: model,
              runConfigSnapshot: {
                version: 'pathfinder-evaluation-run-config-v1',
                maximumCases: MAX_RUN_CASES,
                requestedCases: manifest.length,
                contentSnapshotSchemaVersion: snapshot.schemaVersion,
                contentComponentCounts: snapshot.componentCounts,
              },
              declaredBudgetCeilingE8Usd: budget,
              createdBy: ctx.session.userId,
              triggerType: 'ADMIN_REQUEST',
            },
          })
          return { created, enabled: flag?.enabled ?? false, snapshot }
        })
      })
      const admission = await enqueueEvaluationRun(
        {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: frozen.created.run.id,
          runIdentityHash: frozen.created.run.identityHash,
        },
        { enabled: frozen.enabled },
      )
      return {
        runId: frozen.created.run.id,
        replayed: frozen.created.replayed,
        enqueued: admission.enqueued,
        executionDefaultOff: !frozen.enabled,
        contentSnapshot: {
          schemaVersion: frozen.snapshot.schemaVersion,
          hash: frozen.snapshot.hash,
          contentVersion: frozen.snapshot.contentVersion.toString(),
          componentCounts: frozen.snapshot.componentCounts,
        },
      }
    }),
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
          createdAt: true,
        },
      })

      const hasMore = runs.length > input.limit
      const pageRuns = runs.slice(0, input.limit)
      const runIds = pageRuns.map((run) => run.id)
      if (runIds.length === 0) return { items: [], humanConclusions: [], nextCursor: null }

      const [outcomeCounts, humanConclusions] = await Promise.all([
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
        nextCursor:
          hasMore && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null,
      }
    }),
  ),
})
