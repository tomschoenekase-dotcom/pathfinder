import { randomUUID } from 'node:crypto'

import { AI_MODEL_KEYS, getAiModelSpec } from '@pathfinder/ai'
import { env } from '@pathfinder/config'
import { NativeCoreVisibleState } from '@pathfinder/contracts/native-venue-deployment'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import {
  createOrReplayEvaluationRun,
  db,
  isEvaluationRuntimeDurablyEnabled,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'

export const NATIVE_EVALUATION_MAX_CASES = 50
export const NATIVE_EVALUATION_MAX_BUDGET_E8_USD = 100_000_000n
const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'

export function nativeEvaluationAvailability() {
  return {
    processEnabled: env.EVALUATION_RUNNER_ENABLED,
    requiresDurableGlobalAdmission: true,
    requiresTenantAdmission: true,
    maximumCases: NATIVE_EVALUATION_MAX_CASES,
    maximumBudgetE8Usd: NATIVE_EVALUATION_MAX_BUDGET_E8_USD.toString(),
    advisoryOnly: true as const,
  }
}

export async function requestNativeDeploymentEvaluation(params: {
  tenantId: string
  venueId: string
  releaseId: string
  expectedReleaseUpdatedAt: Date
  operationId: string
  caseIds: string[]
  budgetCeilingE8Usd: bigint
  actorId: string
}) {
  if (!env.EVALUATION_RUNNER_ENABLED)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Evaluation execution is not enabled for this API process',
    })
  return withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const [release, cases, flag, durableGlobalEnabled] = await Promise.all([
        tx.nativeVenueDeploymentRelease.findFirst({
          where: {
            id: params.releaseId,
            tenantId: params.tenantId,
            venueId: params.venueId,
            status: { in: ['DRAFT', 'APPROVED'] },
          },
          select: {
            id: true,
            updatedAt: true,
            manifestHash: true,
            desiredStateHash: true,
            plan: true,
          },
        }),
        tx.evalCase.findMany({
          where: {
            tenantId: params.tenantId,
            venueId: params.venueId,
            id: { in: params.caseIds },
          },
          select: { id: true, revision: true, caseHash: true },
        }),
        tx.tenantFeatureFlag.findUnique({
          where: {
            tenantId_flagKey: {
              tenantId: params.tenantId,
              flagKey: EVALUATION_RUNNER_FLAG,
            },
          },
          select: { enabled: true },
        }),
        isEvaluationRuntimeDurablyEnabled(tx),
      ])
      if (!release)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Reviewable native deployment release was not found',
        })
      if (release.updatedAt.getTime() !== params.expectedReleaseUpdatedAt.getTime())
        throw new TRPCError({ code: 'CONFLICT', message: 'Native deployment release changed' })
      if (!durableGlobalEnabled || flag?.enabled !== true)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Evaluation execution is not durably enabled for this tenant',
        })
      if (cases.length !== params.caseIds.length)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'One or more evaluation cases were not found in the requested venue',
        })
      const plan = release.plan as { desired?: unknown; priorHead?: { revision?: unknown } | null }
      const state = NativeCoreVisibleState.parse(plan.desired)
      const priorRevision = plan.priorHead?.revision
      const contentVersion =
        plan.priorHead === null
          ? 1n
          : typeof priorRevision === 'number'
            ? BigInt(priorRevision + 1)
            : null
      if (contentVersion === null)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Native deployment release snapshot evidence is invalid',
        })
      const byId = new Map(cases.map((item) => [item.id, item]))
      const manifest = params.caseIds.map((caseId) => {
        const item = byId.get(caseId)!
        return { caseId: item.id, revision: item.revision, caseHash: item.caseHash }
      })
      const model = getAiModelSpec(AI_MODEL_KEYS.GUEST_CHAT)
      const created = await createOrReplayEvaluationRun({
        db: tx,
        runId: randomUUID(),
        identity: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          idempotencyKey: `native-evaluation:${params.operationId}`,
          caseManifest: manifest,
          promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
          promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
          packageSnapshotRef: `native-core-v1:${release.id}`,
          packageSnapshotHash: release.manifestHash,
          contentSnapshotKind: 'NATIVE_CORE_V1',
          contentSnapshotRef: release.id,
          contentSnapshotVersion: contentVersion,
          contentSnapshotHash: release.desiredStateHash,
          modelProvider: model.provider,
          modelName: model.model,
          modelSnapshot: model,
          runConfigSnapshot: {
            version: 'pathfinder-native-evaluation-run-config-v1',
            maximumCases: NATIVE_EVALUATION_MAX_CASES,
            requestedCases: manifest.length,
            contentSnapshotSchemaVersion: 'pathfinder-native-evaluation-content-v1',
            contentComponentCounts: {
              places: state.places.length,
              knowledgeEntries: state.knowledgeEntries.length,
              generalizedModules: state.generalizedModules.length,
            },
            contentSnapshot: {
              version: 'pathfinder-native-evaluation-content-v1',
              tenantId: params.tenantId,
              venueId: params.venueId,
              releaseId: release.id,
              state: JSON.parse(JSON.stringify(state)) as never,
            },
          },
          declaredBudgetCeilingE8Usd: params.budgetCeilingE8Usd,
          createdBy: params.actorId,
          triggerType: 'ADMIN_NATIVE_RELEASE_REQUEST',
        },
      })
      return {
        runId: created.run.id,
        status: created.run.status,
        replayed: created.replayed,
        advisoryOnly: true as const,
      }
    }),
  )
}
