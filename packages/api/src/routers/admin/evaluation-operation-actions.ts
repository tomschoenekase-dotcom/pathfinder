import { randomUUID } from 'node:crypto'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'
import { env } from '@pathfinder/config'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'
import {
  appendEvaluationReviewAction,
  createOrReplayEvaluationRun,
  createVenueContentSnapshot,
  db,
  isEvaluationRuntimeDurablyEnabled,
  requestEvaluationRunCancellation,
  withTenantIsolationBypass,
  EvaluationReviewActionError,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const MAX_RUN_CASES = 50
const MAX_RUN_BUDGET_E8_USD = 100_000_000n
const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'

export const adminEvaluationOperationActionsRouter = router({
  appendEvaluationConclusion: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        runId: z.string().uuid(),
        expectedRunIdentityHash: z.string().regex(/^[0-9a-f]{64}$/u),
        resultId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        operationId: z.string().uuid(),
        decision: z.enum(['ACCEPTED', 'REJECTED', 'NEEDS_FOLLOW_UP']),
        conclusion: z.string().trim().min(1).max(1000),
        rubricVersion: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const review = await withTenantIsolationBypass(() =>
          appendEvaluationReviewAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
        return {
          id: review.id,
          resultId: review.resultId,
          reviewerId: review.reviewerId,
          conclusion: review.conclusion,
          decision: review.decision,
          rubricVersion: review.rubricVersion,
          revision: review.revision,
          createdAt: review.createdAt,
          replayed: review.replayed,
          result: {
            runId: review.result.runId,
            caseRevision: review.result.caseRevision,
            evalCase: review.result.evalCase,
          },
        }
      } catch (error) {
        if (error instanceof EvaluationReviewActionError)
          throw new TRPCError({
            code:
              error.code === 'INVALID_INPUT'
                ? 'BAD_REQUEST'
                : error.code === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : 'CONFLICT',
            message: error.message,
          })
        throw error
      }
    }),
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
        nativeReleaseId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const budget = BigInt(input.budgetCeilingE8Usd)
      if (budget > MAX_RUN_BUDGET_E8_USD)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Evaluation run budget exceeds the admin hard limit',
        })
      if (!env.EVALUATION_RUNNER_ENABLED)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Evaluation execution is not enabled for this API process',
        })
      const frozen = await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const [legacySnapshot, nativeRelease, cases, flag, durableGlobalEnabled] =
            await Promise.all([
              input.nativeReleaseId
                ? Promise.resolve(null)
                : createVenueContentSnapshot({
                    db: tx,
                    tenantId: input.tenantId,
                    venueId: input.venueId,
                  }),
              input.nativeReleaseId
                ? tx.nativeVenueDeploymentRelease.findFirst({
                    where: {
                      id: input.nativeReleaseId,
                      tenantId: input.tenantId,
                      venueId: input.venueId,
                      status: { in: ['DRAFT', 'APPROVED'] },
                    },
                    select: {
                      id: true,
                      manifestHash: true,
                      desiredStateHash: true,
                      plan: true,
                    },
                  })
                : Promise.resolve(null),
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
              isEvaluationRuntimeDurablyEnabled(tx),
            ])
          if (!durableGlobalEnabled || flag?.enabled !== true)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Evaluation execution is not durably enabled for this tenant',
            })
          if (cases.length !== input.caseIds.length)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'One or more evaluation cases were not found in the requested venue',
            })
          if (input.nativeReleaseId && !nativeRelease)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Reviewable native deployment release was not found',
            })
          const byId = new Map(cases.map((item) => [item.id, item]))
          const manifest = input.caseIds.map((caseId) => {
            const item = byId.get(caseId)!
            return { caseId: item.id, revision: item.revision, caseHash: item.caseHash }
          })
          const model = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
          const nativePlan = nativeRelease
            ? (nativeRelease.plan as {
                desired?: unknown
                priorHead?: { revision?: unknown } | null
              })
            : null
          const nativeState = nativePlan ? NativeCoreVisibleState.parse(nativePlan.desired) : null
          const priorRevision = nativePlan?.priorHead?.revision
          const nativeRevision = nativePlan
            ? nativePlan.priorHead === null
              ? 1n
              : typeof priorRevision === 'number'
                ? BigInt(priorRevision + 1)
                : null
            : null
          if (nativeRelease && (!nativeState || nativeRevision === null))
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Native deployment release snapshot evidence is invalid',
            })
          const snapshot = nativeRelease
            ? {
                schemaVersion: 'pathfinder-native-evaluation-content-v1',
                hash: nativeRelease.desiredStateHash,
                contentVersion: nativeRevision!,
                componentCounts: {
                  places: nativeState!.places.length,
                  knowledgeEntries: nativeState!.knowledgeEntries.length,
                  generalizedModules: nativeState!.generalizedModules.length,
                },
                manifest: {
                  version: 'pathfinder-native-evaluation-content-v1',
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  releaseId: nativeRelease.id,
                  state: JSON.parse(JSON.stringify(nativeState)) as never,
                },
              }
            : legacySnapshot!
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
              packageSnapshotRef: nativeRelease ? `native-core-v1:${nativeRelease.id}` : null,
              packageSnapshotHash: nativeRelease?.manifestHash ?? null,
              ...(nativeRelease
                ? {
                    contentSnapshotKind: 'NATIVE_CORE_V1' as const,
                    contentSnapshotRef: nativeRelease.id,
                  }
                : {}),
              contentSnapshotVersion: snapshot.contentVersion,
              contentSnapshotHash: snapshot.hash,
              modelProvider: model.provider,
              modelName: model.model,
              modelSnapshot: model,
              runConfigSnapshot: {
                version: nativeRelease
                  ? 'pathfinder-native-evaluation-run-config-v1'
                  : 'pathfinder-evaluation-run-config-v1',
                maximumCases: MAX_RUN_CASES,
                requestedCases: manifest.length,
                contentSnapshotSchemaVersion: snapshot.schemaVersion,
                contentComponentCounts: snapshot.componentCounts,
                contentSnapshot: snapshot.manifest,
              },
              declaredBudgetCeilingE8Usd: budget,
              createdBy: ctx.session.userId,
              triggerType: nativeRelease ? 'ADMIN_NATIVE_RELEASE_REQUEST' : 'ADMIN_REQUEST',
            },
          })
          return { created, snapshot }
        }),
      )
      return {
        runId: frozen.created.run.id,
        replayed: frozen.created.replayed,
        enqueued: false,
        dispatchPending: ['STAGED', 'QUEUED', 'RETRY_SCHEDULED'].includes(
          frozen.created.run.status,
        ),
        executionDefaultOff: false,
        status: frozen.created.run.status,
        contentSnapshot: {
          schemaVersion: frozen.snapshot.schemaVersion,
          hash: frozen.snapshot.hash,
          contentVersion: frozen.snapshot.contentVersion.toString(),
          componentCounts: frozen.snapshot.componentCounts,
        },
      }
    }),
  cancelEvaluationRun: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        runId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const outcome = await requestEvaluationRunCancellation({
        ...input,
        requestedBy: ctx.session.userId,
        requestedByRole: 'PLATFORM_ADMIN',
      })
      if (outcome === 'not-found')
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Evaluation run was not found',
        })
      if (outcome === 'terminal')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A terminal evaluation run cannot be cancelled',
        })
      return { cancellationRequested: true, replayed: outcome === 'already-requested' }
    }),
})
