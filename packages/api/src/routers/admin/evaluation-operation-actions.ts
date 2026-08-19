import { randomUUID } from 'node:crypto'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'
import { env } from '@pathfinder/config'
import { buildOnboardingEvaluationSuite } from '@pathfinder/contracts'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'
import {
  createOrReplayEvaluationCase,
  createOrReplayEvaluationRun,
  createVenueContentSnapshot,
  db,
  evaluationSnapshotHash,
  hashEvalCase,
  isEvaluationRuntimeDurablyEnabled,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const MAX_RUN_CASES = 50
const MAX_RUN_BUDGET_E8_USD = 100_000_000n
const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'

export const adminEvaluationOperationActionsRouter = router({
  prepareOnboardingEvaluationSuite: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        packageId: z.string().min(1).max(191),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const pkg = await tx.venuePackage.findFirst({
            where: {
              id: input.packageId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'APPROVED',
            },
            select: { id: true, payloadHash: true },
          })
          if (!pkg)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Approved onboarding package was not found',
            })

          // Imported at the mutation boundary to keep the approved client projection as the one
          // source of truth without introducing a router-initialization cycle.
          const { loadClientPreview } = await import('../portal')
          const preview = await loadClientPreview(tx, input.tenantId, {
            venueId: input.venueId,
            packageId: input.packageId,
          })
          const suite = buildOnboardingEvaluationSuite(preview)
          const caseKeys = suite.map(({ evalCase }) => evalCase.caseId)
          const existing = await tx.evalCase.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              caseKey: { in: caseKeys },
            },
            orderBy: [{ caseKey: 'asc' }, { revision: 'desc' }],
            select: {
              id: true,
              caseKey: true,
              revision: true,
              caseHash: true,
              sourceType: true,
              sourceRef: true,
            },
          })
          const latest = new Map<string, (typeof existing)[number]>()
          for (const row of existing) if (!latest.has(row.caseKey)) latest.set(row.caseKey, row)

          const sourceType = 'ONBOARDING_APPROVED_PACKAGE'
          const sourceRef = `venue-package:${pkg.id}:${pkg.payloadHash}`
          const prepared = []
          for (const item of suite) {
            const prior = latest.get(item.evalCase.caseId)
            const caseHash = hashEvalCase(item.evalCase)
            const exactReplay =
              prior?.caseHash === caseHash &&
              prior.sourceType === sourceType &&
              prior.sourceRef === sourceRef
            const revision = exactReplay ? prior.revision : (prior?.revision ?? 0) + 1
            const result = await createOrReplayEvaluationCase({
              db: tx,
              caseId: exactReplay ? prior.id : randomUUID(),
              identity: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                caseKey: item.evalCase.caseId,
                revision,
                schemaVersion: item.evalCase.schemaVersion,
                category: item.evalCase.category,
                caseSnapshot: item.evalCase,
                createdBy: ctx.session.userId,
                sourceType,
                sourceRef,
              },
            })
            prepared.push({
              id: result.evalCase.id,
              caseKey: result.evalCase.caseKey,
              revision: result.evalCase.revision,
              category: result.evalCase.category,
              dimension: item.dimension,
              replayed: result.replayed,
            })
          }

          return {
            package: { id: pkg.id, payloadHash: pkg.payloadHash },
            suiteVersion: 'torchiko-onboarding-evaluation-suite-v1' as const,
            cases: prepared,
          }
        }),
      ),
    ),
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
            .max(MAX_RUN_CASES)
            .refine((ids) => new Set(ids).size === ids.length, 'Evaluation cases must be unique'),
          budgetCeilingE8Usd: z.string().regex(/^\d+$/u),
          nativeReleaseId: z.string().uuid().optional(),
          approvedPackageId: z.string().min(1).max(191).optional(),
        })
        .refine((value) => !(value.nativeReleaseId && value.approvedPackageId), {
          message: 'Choose either a native release or an approved package snapshot',
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
          const [
            legacySnapshot,
            nativeRelease,
            approvedPackage,
            cases,
            flag,
            durableGlobalEnabled,
          ] = await Promise.all([
            input.nativeReleaseId || input.approvedPackageId
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
          if (input.approvedPackageId && !approvedPackage)
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Approved onboarding package was not found',
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
                : approvedPackage
                  ? `venue-package-v1:${approvedPackage.id}`
                  : null,
              packageSnapshotHash:
                nativeRelease?.manifestHash ?? approvedPackage?.payloadHash ?? null,
              ...(nativeRelease
                ? {
                    contentSnapshotKind: 'NATIVE_CORE_V1' as const,
                    contentSnapshotRef: nativeRelease.id,
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
                  : approvedPackage
                    ? 'pathfinder-approved-package-evaluation-run-config-v1'
                    : 'pathfinder-evaluation-run-config-v1',
                maximumCases: MAX_RUN_CASES,
                requestedCases: manifest.length,
                contentSnapshotSchemaVersion: snapshot.schemaVersion,
                contentComponentCounts: snapshot.componentCounts,
                contentSnapshot: snapshot.manifest,
              },
              declaredBudgetCeilingE8Usd: budget,
              createdBy: ctx.session.userId,
              triggerType: nativeRelease
                ? 'ADMIN_NATIVE_RELEASE_REQUEST'
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
