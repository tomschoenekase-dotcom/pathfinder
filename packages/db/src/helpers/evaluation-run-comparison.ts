import { canonicalEvaluationJson, EvalCaseManifestSchema } from '@pathfinder/contracts/evaluation'

import { db } from '../client'

const MAX_COMPARISON_CASES = 50

export type EvaluationComparisonMismatch = 'CORPUS' | 'CONTENT' | 'MODEL' | 'CONFIG' | 'EVIDENCE'
export type EvaluationComparisonClassification =
  | 'NEW_FAILURE'
  | 'RESOLVED_FAILURE'
  | 'UNCHANGED_FAILURE'
  | 'UNCHANGED_PASS'
  | 'BASELINE_RESULT_MISSING'
  | 'CANDIDATE_RESULT_MISSING'
  | 'BOTH_RESULTS_MISSING'

export class EvaluationRunComparisonError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'EvaluationRunComparisonError'
  }
}

type EvaluationComparisonClient = Pick<typeof db, 'evalRun' | 'evalCase' | 'evalResult'>

const runSelect = {
  id: true,
  identityHash: true,
  corpusHash: true,
  caseManifestSnapshot: true,
  promptContractVersion: true,
  promptContractHash: true,
  packageSnapshotRef: true,
  packageSnapshotHash: true,
  contentSnapshotKind: true,
  contentSnapshotRef: true,
  contentSnapshotVersion: true,
  contentSnapshotHash: true,
  modelProvider: true,
  modelName: true,
  modelSnapshotHash: true,
  runConfigSnapshot: true,
  status: true,
  createdAt: true,
} as const

function scoreBasisPoints(
  result: {
    passedChecks: number | null
    totalChecks: number | null
  } | null,
) {
  if (!result || result.passedChecks === null || !result.totalChecks) return null
  return Math.round((result.passedChecks / result.totalChecks) * 10_000)
}

function isFailure(result: { outcome: string; passed: boolean | null } | null) {
  return result !== null && (result.outcome !== 'SCORED' || result.passed !== true)
}

function classification(
  baseline: { outcome: string; passed: boolean | null } | null,
  candidate: { outcome: string; passed: boolean | null } | null,
): EvaluationComparisonClassification {
  if (!baseline && !candidate) return 'BOTH_RESULTS_MISSING'
  if (!baseline) return 'BASELINE_RESULT_MISSING'
  if (!candidate) return 'CANDIDATE_RESULT_MISSING'
  const beforeFailed = isFailure(baseline)
  const afterFailed = isFailure(candidate)
  if (!beforeFailed && afterFailed) return 'NEW_FAILURE'
  if (beforeFailed && !afterFailed) return 'RESOLVED_FAILURE'
  if (beforeFailed && afterFailed) return 'UNCHANGED_FAILURE'
  return 'UNCHANGED_PASS'
}

function runSummary(
  run: Awaited<ReturnType<EvaluationComparisonClient['evalRun']['findFirstOrThrow']>>,
) {
  return {
    id: run.id,
    identityHash: run.identityHash,
    status: run.status,
    createdAt: run.createdAt,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    contentSnapshotKind: run.contentSnapshotKind,
    contentSnapshotRef: run.contentSnapshotRef,
    contentSnapshotVersion: run.contentSnapshotVersion.toString(),
  }
}

export async function compareEvaluationRuns(
  input: { tenantId: string; venueId: string; baselineRunId: string; candidateRunId: string },
  client: EvaluationComparisonClient = db,
) {
  if (!input.tenantId.trim() || !input.venueId.trim())
    throw new EvaluationRunComparisonError(
      'INVALID_INPUT',
      'Exact tenant and venue scope is required.',
    )
  if (input.baselineRunId === input.candidateRunId)
    throw new EvaluationRunComparisonError('INVALID_INPUT', 'Select two different evaluation runs.')

  const runs = await client.evalRun.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      id: { in: [input.baselineRunId, input.candidateRunId] },
    },
    select: runSelect,
  })
  const baseline = runs.find((run) => run.id === input.baselineRunId)
  const candidate = runs.find((run) => run.id === input.candidateRunId)
  if (!baseline || !candidate)
    throw new EvaluationRunComparisonError(
      'NOT_FOUND',
      'One or both evaluation runs were not found.',
    )

  const mismatchReasons = new Set<EvaluationComparisonMismatch>()
  if (baseline.corpusHash !== candidate.corpusHash) mismatchReasons.add('CORPUS')
  if (
    baseline.contentSnapshotKind !== candidate.contentSnapshotKind ||
    baseline.contentSnapshotRef !== candidate.contentSnapshotRef ||
    baseline.contentSnapshotVersion !== candidate.contentSnapshotVersion ||
    baseline.contentSnapshotHash !== candidate.contentSnapshotHash ||
    baseline.packageSnapshotRef !== candidate.packageSnapshotRef ||
    baseline.packageSnapshotHash !== candidate.packageSnapshotHash
  )
    mismatchReasons.add('CONTENT')
  if (
    baseline.modelProvider !== candidate.modelProvider ||
    baseline.modelName !== candidate.modelName ||
    baseline.modelSnapshotHash !== candidate.modelSnapshotHash
  )
    mismatchReasons.add('MODEL')
  if (
    baseline.promptContractVersion !== candidate.promptContractVersion ||
    baseline.promptContractHash !== candidate.promptContractHash ||
    canonicalEvaluationJson(baseline.runConfigSnapshot as never) !==
      canonicalEvaluationJson(candidate.runConfigSnapshot as never)
  )
    mismatchReasons.add('CONFIG')

  const baselineManifest = EvalCaseManifestSchema.safeParse(baseline.caseManifestSnapshot)
  const candidateManifest = EvalCaseManifestSchema.safeParse(candidate.caseManifestSnapshot)
  if (
    !baselineManifest.success ||
    !candidateManifest.success ||
    baselineManifest.data.length > MAX_COMPARISON_CASES ||
    candidateManifest.data.length > MAX_COMPARISON_CASES ||
    (baselineManifest.success &&
      candidateManifest.success &&
      canonicalEvaluationJson(baselineManifest.data as never) !==
        canonicalEvaluationJson(candidateManifest.data as never))
  )
    mismatchReasons.add('EVIDENCE')

  const base = runSummary(baseline as never)
  const next = runSummary(candidate as never)
  if (mismatchReasons.size > 0)
    return {
      status: 'INCOMPARABLE' as const,
      baseline: base,
      candidate: next,
      mismatchReasons: [...mismatchReasons].sort(),
      cases: [],
      totals: null,
    }

  const manifest = baselineManifest.data!
  const manifestIdentityKeys = manifest.map(
    (item) => `${item.caseId}:${item.revision}:${item.caseHash}`,
  )
  if (
    new Set(manifestIdentityKeys).size !== manifestIdentityKeys.length ||
    new Set(manifest.map((item) => item.caseId)).size !== manifest.length
  )
    return {
      status: 'INCOMPARABLE' as const,
      baseline: base,
      candidate: next,
      mismatchReasons: ['EVIDENCE' as const],
      cases: [],
      totals: null,
    }
  const caseIds = manifest.map((item) => item.caseId)
  const [cases, results] = await Promise.all([
    client.evalCase.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, id: { in: caseIds } },
      select: { id: true, caseKey: true, revision: true, caseHash: true, category: true },
    }),
    client.evalResult.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: { in: [baseline.id, candidate.id] },
      },
      select: {
        id: true,
        runId: true,
        caseId: true,
        caseRevision: true,
        caseHash: true,
        outcome: true,
        passed: true,
        passedChecks: true,
        totalChecks: true,
        errorCode: true,
        latencyMs: true,
        costE8Usd: true,
        reviews: { orderBy: { revision: 'desc' as const }, take: 1, select: { revision: true } },
      },
    }),
  ])
  const caseById = new Map(cases.map((item) => [item.id, item]))
  const manifestByCaseId = new Map(manifest.map((item) => [item.caseId, item]))
  const resultIdentityKeys = results.map(
    (item) => `${item.runId}:${item.caseId}:${item.caseRevision}`,
  )
  const resultByIdentity = new Map(
    results.map((item) => [`${item.runId}:${item.caseId}:${item.caseRevision}`, item]),
  )
  if (
    new Set(resultIdentityKeys).size !== resultIdentityKeys.length ||
    results.some((result) => {
      const expected = manifestByCaseId.get(result.caseId)
      return (
        !expected ||
        result.caseRevision !== expected.revision ||
        result.caseHash !== expected.caseHash
      )
    }) ||
    manifest.some((item) => {
      const stored = caseById.get(item.caseId)
      return !stored || stored.revision !== item.revision || stored.caseHash !== item.caseHash
    })
  )
    return {
      status: 'INCOMPARABLE' as const,
      baseline: base,
      candidate: next,
      mismatchReasons: ['EVIDENCE' as const],
      cases: [],
      totals: null,
    }

  const rows = manifest.map((item) => {
    const evalCase = caseById.get(item.caseId)!
    const before = resultByIdentity.get(`${baseline.id}:${item.caseId}:${item.revision}`) ?? null
    const after = resultByIdentity.get(`${candidate.id}:${item.caseId}:${item.revision}`) ?? null
    const beforeScore = scoreBasisPoints(before)
    const afterScore = scoreBasisPoints(after)
    return {
      caseKey: evalCase.caseKey,
      caseRevision: evalCase.revision,
      category: evalCase.category,
      classification: classification(before, after),
      baseline: before
        ? {
            resultId: before.id,
            outcome: before.outcome,
            passed: before.passed,
            errorCode: before.errorCode,
            latencyMs: before.latencyMs,
            costE8Usd: before.costE8Usd.toString(),
            scoreBasisPoints: beforeScore,
          }
        : null,
      candidate: after
        ? {
            resultId: after.id,
            outcome: after.outcome,
            passed: after.passed,
            errorCode: after.errorCode,
            latencyMs: after.latencyMs,
            costE8Usd: after.costE8Usd.toString(),
            scoreBasisPoints: afterScore,
            latestReviewRevision: after.reviews[0]?.revision ?? 0,
          }
        : null,
      latencyDeltaMs: before && after ? after.latencyMs - before.latencyMs : null,
      costDeltaE8Usd: before && after ? (after.costE8Usd - before.costE8Usd).toString() : null,
      scoreDeltaBasisPoints:
        beforeScore !== null && afterScore !== null ? afterScore - beforeScore : null,
    }
  })
  rows.sort(
    (left, right) =>
      left.caseKey.localeCompare(right.caseKey) || left.caseRevision - right.caseRevision,
  )

  const count = (value: EvaluationComparisonClassification) =>
    rows.filter((row) => row.classification === value).length
  const baselineLatencyMs = rows.reduce((sum, row) => sum + (row.baseline?.latencyMs ?? 0), 0)
  const candidateLatencyMs = rows.reduce((sum, row) => sum + (row.candidate?.latencyMs ?? 0), 0)
  const baselineCost = rows.reduce((sum, row) => sum + BigInt(row.baseline?.costE8Usd ?? '0'), 0n)
  const candidateCost = rows.reduce((sum, row) => sum + BigInt(row.candidate?.costE8Usd ?? '0'), 0n)

  return {
    status: 'COMPARABLE' as const,
    baseline: base,
    candidate: next,
    mismatchReasons: [],
    cases: rows,
    totals: {
      caseCount: rows.length,
      newFailures: count('NEW_FAILURE'),
      resolvedFailures: count('RESOLVED_FAILURE'),
      unchangedFailures: count('UNCHANGED_FAILURE'),
      missingResults:
        count('BASELINE_RESULT_MISSING') +
        count('CANDIDATE_RESULT_MISSING') +
        count('BOTH_RESULTS_MISSING'),
      baselineLatencyMs,
      candidateLatencyMs,
      latencyDeltaMs: candidateLatencyMs - baselineLatencyMs,
      baselineCostE8Usd: baselineCost.toString(),
      candidateCostE8Usd: candidateCost.toString(),
      costDeltaE8Usd: (candidateCost - baselineCost).toString(),
    },
  }
}
