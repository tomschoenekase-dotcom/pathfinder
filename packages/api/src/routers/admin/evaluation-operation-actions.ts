import { randomUUID } from 'node:crypto'

import { getAiModelSpec } from '@pathfinder/ai'
import { env } from '@pathfinder/config'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'
import {
  createOrReplayEvaluationRun,
  createVenueContentSnapshot,
  db,
  evaluationSnapshotHash,
  getEvaluationRuntimeAuthorization,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { loadReviewableVenuePackageEvaluationPreview } from '../../lib/reviewable-package-evaluation'
import { adminProcedure } from '../../trpc'
import { authorizeEvaluation, EVALUATION_RUNNER_FLAG } from './evaluation-runtime-authorization'
import {
  EVALUATION_MODEL_KEYS,
  MAX_EVALUATION_RUN_BUDGET_E8_USD,
  MAX_EVALUATION_RUN_CASES,
} from './evaluation-policy'

export const adminEvaluationOperationActionsRouter = router({
  requestEvaluationRun: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          idempotencyKey: z.string().trim().min(1).max(191),
          caseIds: z
            .array(z.string().uuid())
            .min(1)
            .max(MAX_EVALUATION_RUN_CASES)
            .refine((ids) => new Set(ids).size === ids.length, 'Evaluation cases must be unique'),
          budgetCeilingE8Usd: z.string().regex(/^\d+$/u),
          modelKey: z.enum(EVALUATION_MODEL_KEYS).default(EVALUATION_MODEL_KEYS[0]),
          nativeReleaseId: z.string().uuid().optional(),
          approvedPackageId: z.string().min(1).max(191).optional(),
          reviewablePackageId: z.string().min(1).max(191).optional(),
        })
        .superRefine((value, context) => {
          const selected = [
            value.nativeReleaseId,
            value.approvedPackageId,
            value.reviewablePackageId,
          ].filter(Boolean)
          if (selected.length > 1)
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Choose exactly one optional release or package snapshot target',
            })
        }),
    )
    .mutation(async ({ input, ctx }) => {
      const budget = BigInt(input.budgetCeilingE8Usd)
      if (budget > MAX_EVALUATION_RUN_BUDGET_E8_USD)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Evaluation run budget exceeds the admin hard limit',
        })
      if (!env.EVALUATION_RUNNER_ENABLED)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Evaluation execution is not enabled for this API process',
        })
      const model = getAiModelSpec(input.modelKey)
      const frozen = await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const [
            legacySnapshot,
            nativeRelease,
            approvedPackage,
            reviewablePackage,
            cases,
            flag,
            durableAuthorization,
          ] = await Promise.all([
            input.nativeReleaseId || input.approvedPackageId || input.reviewablePackageId
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
            input.approvedPackageId
              ? tx.venuePackage.findFirst({
                  where: {
                    id: input.approvedPackageId,
                    tenantId: input.tenantId,
                    venueId: input.venueId,
                    status: 'APPROVED',
                  },
                  select: { id: true, payloadHash: true },
                })
              : Promise.resolve(null),
            input.reviewablePackageId
              ? tx.venuePackage.findFirst({
                  where: {
                    id: input.reviewablePackageId,
                    tenantId: input.tenantId,
                    venueId: input.venueId,
                    status: { in: ['DRAFT', 'APPROVED'] },
                  },
                  select: {
                    id: true,
                    payloadHash: true,
                    baseDigest: true,
                    status: true,
                  },
                })
              : Promise.resolve(null),
            tx.evalCase.findMany({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                id: { in: input.caseIds },
              },
              select: {
                id: true,
                revision: true,
                caseHash: true,
                sourceType: true,
                sourceRef: true,
              },
            }),
            tx.tenantFeatureFlag.findUnique({
              where: {
                tenantId_flagKey: { tenantId: input.tenantId, flagKey: EVALUATION_RUNNER_FLAG },
              },
              select: { enabled: true },
            }),
            getEvaluationRuntimeAuthorization(tx),
          ])
          if (!durableAuthorization || flag?.enabled !== true)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Evaluation execution is not durably enabled for this tenant',
            })
          const authorizationSnapshot = authorizeEvaluation(
            durableAuthorization,
            model.provider,
            budget,
          )
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
          if (input.approvedPackageId && !approvedPackage)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Approved onboarding package was not found',
            })
          if (input.reviewablePackageId && !reviewablePackage)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Reviewable onboarding package was not found',
            })
          if (reviewablePackage) {
            const expectedSourceRef = `venue-package-review:${reviewablePackage.id}:${reviewablePackage.payloadHash}:${reviewablePackage.baseDigest}`
            if (
              cases.some(
                (item) =>
                  item.sourceType !== 'ONBOARDING_REVIEWABLE_PACKAGE' ||
                  item.sourceRef !== expectedSourceRef,
              )
            )
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Every selected case must belong to this exact reviewable package',
              })
          }
          const byId = new Map(cases.map((item) => [item.id, item]))
          const manifest = input.caseIds.map((caseId) => {
            const item = byId.get(caseId)!
            return { caseId: item.id, revision: item.revision, caseHash: item.caseHash }
          })
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
          const approvedPreview = approvedPackage
            ? await (
                await import('../portal')
              ).loadClientPreview(tx, input.tenantId, {
                venueId: input.venueId,
                packageId: approvedPackage.id,
              })
            : null
          const approvedContent = approvedPackage
            ? {
                version: 'pathfinder-approved-package-evaluation-content-v1',
                tenantId: input.tenantId,
                venueId: input.venueId,
                packageId: approvedPackage.id,
                preview: approvedPreview!,
              }
            : null
          const reviewable = reviewablePackage
            ? await loadReviewableVenuePackageEvaluationPreview(tx, input.tenantId, {
                venueId: input.venueId,
                packageId: reviewablePackage.id,
              })
            : null
          const reviewableContent = reviewable
            ? {
                version: 'pathfinder-reviewable-package-evaluation-content-v1',
                tenantId: input.tenantId,
                venueId: input.venueId,
                packageId: reviewable.package.id,
                packageStatus: reviewable.package.status,
                payloadHash: reviewable.package.payloadHash,
                baseDigest: reviewable.package.baseDigest,
                preview: reviewable.preview,
              }
            : null
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
            : reviewablePackage
              ? {
                  schemaVersion: 'pathfinder-reviewable-package-evaluation-content-v1',
                  hash: evaluationSnapshotHash(
                    'pathfinder-reviewable-package-evaluation-content-v1',
                    reviewableContent as never,
                  ),
                  contentVersion: 1n,
                  componentCounts: {
                    places: reviewable!.preview.experience.summary.placeCount,
                    knowledgeEntries: reviewable!.preview.experience.summary.knowledgeEntryCount,
                  },
                  manifest: reviewableContent!,
                }
              : approvedPackage
                ? {
                    schemaVersion: 'pathfinder-approved-package-evaluation-content-v1',
                    hash: evaluationSnapshotHash(
                      'pathfinder-approved-client-package-preview-v1',
                      approvedContent as never,
                    ),
                    contentVersion: 1n,
                    componentCounts: {
                      places: approvedPreview!.experience.summary.placeCount,
                      knowledgeEntries: approvedPreview!.experience.summary.knowledgeEntryCount,
                    },
                    manifest: approvedContent!,
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
              packageSnapshotRef: nativeRelease
                ? `native-core-v1:${nativeRelease.id}`
                : reviewablePackage
                  ? `venue-package-review-v1:${reviewablePackage.id}`
                  : approvedPackage
                    ? `venue-package-v1:${approvedPackage.id}`
                    : null,
              packageSnapshotHash:
                nativeRelease?.manifestHash ??
                reviewablePackage?.payloadHash ??
                approvedPackage?.payloadHash ??
                null,
              ...(nativeRelease
                ? {
                    contentSnapshotKind: 'NATIVE_CORE_V1' as const,
                    contentSnapshotRef: nativeRelease.id,
                  }
                : reviewablePackage
                  ? {
                      contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1' as const,
                      contentSnapshotRef: reviewablePackage.id,
                    }
                  : approvedPackage
                    ? {
                        contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1' as const,
                        contentSnapshotRef: approvedPackage.id,
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
                  : reviewablePackage
                    ? 'pathfinder-reviewable-package-evaluation-run-config-v1'
                    : approvedPackage
                      ? 'pathfinder-approved-package-evaluation-run-config-v1'
                      : 'pathfinder-evaluation-run-config-v1',
                maximumCases: MAX_EVALUATION_RUN_CASES,
                requestedCases: manifest.length,
                modelKey: input.modelKey,
                authorization: authorizationSnapshot,
                contentSnapshotSchemaVersion: snapshot.schemaVersion,
                contentComponentCounts: snapshot.componentCounts,
                contentSnapshot: snapshot.manifest,
              },
              declaredBudgetCeilingE8Usd: budget,
              createdBy: ctx.session.userId,
              triggerType: nativeRelease
                ? 'ADMIN_NATIVE_RELEASE_REQUEST'
                : reviewablePackage
                  ? 'ADMIN_REVIEWABLE_PACKAGE_REQUEST'
                  : approvedPackage
                    ? 'ADMIN_APPROVED_PACKAGE_REQUEST'
                    : 'ADMIN_REQUEST',
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
})
