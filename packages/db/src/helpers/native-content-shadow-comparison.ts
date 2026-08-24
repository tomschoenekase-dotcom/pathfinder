import { db } from '../client'
import {
  compareEvaluationRuns,
  type EvaluationComparisonMismatch,
} from './evaluation-run-comparison'

type Client = Pick<
  typeof db,
  'evalRun' | 'evalCase' | 'evalResult' | 'nativeVenueDeploymentRelease'
>

export class NativeContentShadowComparisonError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'NativeContentShadowComparisonError'
  }
}

const declaredChangeReasons = [
  'CONTENT',
  'CONFIG',
] as const satisfies readonly EvaluationComparisonMismatch[]

/**
 * Compares one frozen legacy guest-content run with one frozen native-release run.
 *
 * Content and snapshot-wrapper configuration are the only declared changes. The
 * shared comparison engine still fails closed on corpus, case evidence, model,
 * and prompt identity differences. This is advisory measurement only: it cannot
 * change the guest read path or authorize compatibility-data retirement.
 */
export async function compareNativeContentShadowRuns(
  input: {
    tenantId: string
    venueId: string
    releaseId: string
    baselineRunId: string
    candidateRunId: string
  },
  client: Client = db,
) {
  if (!input.tenantId.trim() || !input.venueId.trim() || !input.releaseId.trim())
    throw new NativeContentShadowComparisonError(
      'INVALID_INPUT',
      'Exact tenant, venue, and native release scope is required.',
    )
  if (input.baselineRunId === input.candidateRunId)
    throw new NativeContentShadowComparisonError(
      'INVALID_INPUT',
      'Select different baseline and candidate runs.',
    )

  const [release, runs] = await Promise.all([
    client.nativeVenueDeploymentRelease.findFirst({
      where: { id: input.releaseId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true },
    }),
    client.evalRun.findMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        id: { in: [input.baselineRunId, input.candidateRunId] },
      },
      select: {
        id: true,
        status: true,
        contentSnapshotKind: true,
        contentSnapshotRef: true,
      },
    }),
  ])
  if (!release)
    throw new NativeContentShadowComparisonError('NOT_FOUND', 'Native release was not found.')
  const baseline = runs.find((run) => run.id === input.baselineRunId)
  const candidate = runs.find((run) => run.id === input.candidateRunId)
  if (!baseline || !candidate)
    throw new NativeContentShadowComparisonError(
      'NOT_FOUND',
      'One or both evaluation runs were not found in this venue.',
    )
  if (baseline.status !== 'COMPLETED' || baseline.contentSnapshotKind !== 'LEGACY_VENUE_CONTENT_V1')
    throw new NativeContentShadowComparisonError(
      'PRECONDITION_FAILED',
      'The baseline must be a completed frozen legacy guest-content run.',
    )
  if (
    candidate.status !== 'COMPLETED' ||
    candidate.contentSnapshotKind !== 'NATIVE_CORE_V1' ||
    candidate.contentSnapshotRef !== release.id
  )
    throw new NativeContentShadowComparisonError(
      'PRECONDITION_FAILED',
      'The candidate must be a completed frozen run for this exact native release.',
    )

  const comparison = await compareEvaluationRuns(
    {
      tenantId: input.tenantId,
      venueId: input.venueId,
      baselineRunId: input.baselineRunId,
      candidateRunId: input.candidateRunId,
      allowedMismatchReasons: declaredChangeReasons,
    },
    client,
  )
  return {
    ...comparison,
    measurement: 'LEGACY_TO_NATIVE_GUEST_CONTENT_SHADOW_V1' as const,
    advisoryOnly: true as const,
    guestReadPathChanged: false as const,
    cutoverAuthorized: false as const,
    legacyRetirementAuthorized: false as const,
  }
}
