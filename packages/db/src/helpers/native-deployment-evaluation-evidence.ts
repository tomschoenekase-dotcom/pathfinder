import { createHash } from 'node:crypto'

import {
  EvalCaseManifestSchema,
  RecordNativeDeploymentEvaluationEvidenceInputSchema,
  type RecordNativeDeploymentEvaluationEvidenceInput,
} from '@pathfinder/contracts/evaluation'

import { db } from '../client'
import { isVerifiedEvaluationRunIdentity } from './evaluation-runs'
import { writeAuditLogStrict } from './audit'
import { lockVenueContentMutation } from './venue-content-lock'

export type NativeDeploymentEvaluationActor = {
  type: 'HUMAN'
  role: 'PLATFORM_ADMIN'
  id: string
}

export class NativeDeploymentEvaluationEvidenceError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
  }
}

type Client = typeof db
const txOptions = { isolationLevel: 'Serializable' as const, maxWait: 5_000, timeout: 30_000 }
const isRetryable = (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['P2002', 'P2034'].includes(String((error as { code?: unknown }).code)),
  )

function operationHash(input: RecordNativeDeploymentEvaluationEvidenceInput, actorId: string) {
  return createHash('sha256')
    .update(
      [
        'native-deployment-evaluation-evidence-v1',
        input.tenantId,
        input.venueId,
        input.releaseId,
        input.runId,
        input.expectedRunIdentityHash,
        input.operationId,
        actorId,
      ].join('\n'),
      'utf8',
    )
    .digest('hex')
}

function safeEvidence(value: Record<string, unknown>, replayed: boolean) {
  return {
    id: value.id,
    releaseId: value.releaseId,
    runId: value.runId,
    disposition: value.disposition,
    manifestCaseCount: value.manifestCaseCount,
    scoredCaseCount: value.scoredCaseCount,
    passedCaseCount: value.passedCaseCount,
    failedCaseCount: value.failedCaseCount,
    operationalFailureCount: value.operationalFailureCount,
    totalLatencyMs: value.totalLatencyMs,
    totalCostE8Usd: String(value.totalCostE8Usd),
    runCompletedAt: value.runCompletedAt,
    createdAt: value.createdAt,
    replayed,
    advisoryOnly: true as const,
  }
}

export async function recordNativeDeploymentEvaluationEvidenceAction(
  rawInput: RecordNativeDeploymentEvaluationEvidenceInput & {
    actor: NativeDeploymentEvaluationActor
  },
  client: Client = db,
) {
  if (
    rawInput.actor.type !== 'HUMAN' ||
    rawInput.actor.role !== 'PLATFORM_ADMIN' ||
    !rawInput.actor.id.trim()
  )
    throw new NativeDeploymentEvaluationEvidenceError(
      'INVALID_INPUT',
      'A platform administrator is required.',
    )
  const input = RecordNativeDeploymentEvaluationEvidenceInputSchema.parse({
    tenantId: rawInput.tenantId,
    venueId: rawInput.venueId,
    releaseId: rawInput.releaseId,
    runId: rawInput.runId,
    expectedRunIdentityHash: rawInput.expectedRunIdentityHash,
    operationId: rawInput.operationId,
  })
  const hash = operationHash(input, rawInput.actor.id)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        await lockVenueContentMutation(tx, input)
        const release = await tx.nativeVenueDeploymentRelease.findFirst({
          where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
          select: {
            id: true,
            artifactId: true,
            manifestHash: true,
            desiredStateHash: true,
            status: true,
            plan: true,
          },
        })
        if (!release)
          throw new NativeDeploymentEvaluationEvidenceError(
            'NOT_FOUND',
            'Native deployment release was not found.',
          )

        const replay = await tx.nativeVenueDeploymentEvaluationEvidence.findFirst({
          where: { tenantId: input.tenantId, operationId: input.operationId },
        })
        if (replay?.operationHash !== undefined && replay.operationHash !== hash)
          throw new NativeDeploymentEvaluationEvidenceError(
            'CONFLICT',
            'Operation identifier was reused for different evaluation evidence.',
          )

        const run = await tx.evalRun.findFirst({
          where: {
            id: input.runId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            identityHash: input.expectedRunIdentityHash,
          },
        })
        if (!run)
          throw new NativeDeploymentEvaluationEvidenceError(
            'NOT_FOUND',
            'Evaluation run was not found.',
          )
        const priorHead = (release.plan as { priorHead?: { revision?: unknown } | null }).priorHead
        const priorRevision = priorHead?.revision
        const plannedRevision =
          priorHead === null
            ? 1n
            : typeof priorRevision === 'number'
              ? BigInt(priorRevision + 1)
              : null
        if (
          !isVerifiedEvaluationRunIdentity(run) ||
          run.status !== 'COMPLETED' ||
          !run.completedAt ||
          run.contentSnapshotKind !== 'NATIVE_CORE_V1' ||
          run.contentSnapshotRef !== release.id ||
          plannedRevision === null ||
          run.contentSnapshotVersion !== plannedRevision ||
          run.contentSnapshotHash !== release.desiredStateHash ||
          run.packageSnapshotRef !== `native-core-v1:${release.id}` ||
          run.packageSnapshotHash !== release.manifestHash
        )
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Evaluation run is not exact completed evidence for this release.',
          )
        if (replay) {
          if (
            replay.releaseId !== release.id ||
            replay.artifactId !== release.artifactId ||
            replay.manifestHash !== release.manifestHash ||
            replay.desiredStateHash !== release.desiredStateHash ||
            replay.runId !== run.id ||
            replay.runIdentityHash !== run.identityHash ||
            replay.runCompletedAt.getTime() !== run.completedAt.getTime()
          )
            throw new NativeDeploymentEvaluationEvidenceError(
              'CONFLICT',
              'Persisted evaluation evidence is inconsistent.',
            )
          return safeEvidence(replay, true)
        }
        if (!['DRAFT', 'APPROVED'].includes(release.status))
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Advisory evaluation evidence must be recorded before apply.',
          )

        const parsedManifest = EvalCaseManifestSchema.safeParse(run.caseManifestSnapshot)
        if (!parsedManifest.success || parsedManifest.data.length > 50)
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Evaluation run manifest evidence is invalid.',
          )
        const results = await tx.evalResult.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId, runId: run.id },
          select: {
            caseId: true,
            caseRevision: true,
            caseHash: true,
            outcome: true,
            passed: true,
            latencyMs: true,
            costE8Usd: true,
          },
        })
        const expected = new Map(
          parsedManifest.data.map((item) => [`${item.caseId}:${item.revision}`, item.caseHash]),
        )
        const identities = results.map((item) => `${item.caseId}:${item.caseRevision}`)
        if (
          results.length !== parsedManifest.data.length ||
          new Set(identities).size !== identities.length ||
          results.some(
            (item) => expected.get(`${item.caseId}:${item.caseRevision}`) !== item.caseHash,
          )
        )
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Evaluation result evidence is incomplete or inconsistent.',
          )
        const scored = results.filter((item) => item.outcome === 'SCORED')
        if (scored.some((item) => item.passed === null))
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Scored evaluation evidence is incomplete.',
          )
        const passed = scored.filter((item) => item.passed === true).length
        const failed = scored.length - passed
        const operational = results.length - scored.length
        const disposition =
          operational > 0 ? 'OPERATIONAL_FAILURE' : failed > 0 ? 'QUALITY_FAILURE' : 'PASS'
        const latency = results.reduce((sum, item) => sum + item.latencyMs, 0)
        if (!Number.isSafeInteger(latency) || latency > 2_147_483_647)
          throw new NativeDeploymentEvaluationEvidenceError(
            'PRECONDITION_FAILED',
            'Evaluation latency summary exceeds the supported bound.',
          )
        const cost = results.reduce((sum, item) => sum + item.costE8Usd, 0n)
        const now = new Date()
        const evidence = await tx.nativeVenueDeploymentEvaluationEvidence.create({
          data: {
            id: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            releaseId: release.id,
            artifactId: release.artifactId,
            manifestHash: release.manifestHash,
            desiredStateHash: release.desiredStateHash,
            runId: run.id,
            runIdentityHash: run.identityHash,
            runCompletedAt: run.completedAt,
            disposition,
            manifestCaseCount: results.length,
            scoredCaseCount: scored.length,
            passedCaseCount: passed,
            failedCaseCount: failed,
            operationalFailureCount: operational,
            totalLatencyMs: latency,
            totalCostE8Usd: cost,
            operationId: input.operationId,
            operationHash: hash,
            actorType: 'HUMAN',
            actorRole: 'PLATFORM_ADMIN',
            recordedBy: rawInput.actor.id,
            createdAt: now,
          },
        })
        await writeAuditLogStrict(
          {
            tenantId: input.tenantId,
            actorId: rawInput.actor.id,
            actorRole: 'PLATFORM_ADMIN',
            action: 'native_venue_deployment.evaluation-evidence-recorded',
            targetType: 'NativeVenueDeploymentEvaluationEvidence',
            targetId: evidence.id,
            createdAt: now,
            beforeState: { status: 'ABSENT' },
            afterState: {
              venueId: input.venueId,
              releaseId: release.id,
              runId: run.id,
              disposition,
              manifestCaseCount: results.length,
            },
          },
          tx,
        )
        return safeEvidence(evidence, false)
      }, txOptions)
    } catch (error) {
      if (!isRetryable(error)) throw error
      if (attempt === 2)
        throw new NativeDeploymentEvaluationEvidenceError(
          'CONFLICT',
          'Evaluation evidence transaction did not converge.',
        )
    }
  }
  throw new NativeDeploymentEvaluationEvidenceError(
    'CONFLICT',
    'Evaluation evidence transaction did not converge.',
  )
}
