import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { deriveFounderAbsenceReadiness } from './routers/admin/attention-founder-absence'

const dimensionSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  visibleSignals: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  state: z.enum(['REVIEW_CANDIDATES', 'NO_VISIBLE_SIGNAL']),
  interpretation: z.string().min(1).max(1_000),
})

export const founderAbsenceObservationSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.object({
    dimensionsWithReviewCandidates: z.number().int().nonnegative(),
    visibleSignals: z.number().int().nonnegative(),
  }),
  dimensions: z.array(dimensionSchema).min(1).max(20),
  evidenceWindow: z.object({
    kind: z.literal('BOUNDED_CURRENT_STATE'),
    complete: z.boolean(),
    hasMore: z.boolean(),
    historicalContinuityVerified: z.boolean(),
  }),
})

export type FounderAbsenceObservationSnapshot = z.infer<
  typeof founderAbsenceObservationSnapshotSchema
>

type CurrentReadiness = {
  summary: FounderAbsenceObservationSnapshot['summary']
  dimensions: FounderAbsenceObservationSnapshot['dimensions']
  evidenceWindow: FounderAbsenceObservationSnapshot['evidenceWindow']
  target: Record<string, unknown>
  authority: Record<string, unknown>
}

type ObservedReadiness<T extends CurrentReadiness> = Omit<
  T,
  'schemaVersion' | 'target' | 'observationHistory' | 'evidenceWindow'
> & {
  schemaVersion: 2
  target: {
    ordinaryOperationDays: 7
    launchGate: false
    certification: 'NOT_CERTIFIED'
    observationState: 'NOT_STARTED' | 'IN_PROGRESS' | 'READY_FOR_REVIEW'
    observedDays: number
    explanation: string
  }
  observationHistory: {
    retainedDays: number
    consecutiveDays: number
    latestObservedOn: string | null
    latestCapturedAt: Date | null
    latestReleaseSha: string | null
    stale: boolean
    incompleteSamples: number
    immutableDailySamples: true
  }
  evidenceWindow: FounderAbsenceObservationSnapshot['evidenceWindow']
}

type ObservationRow = {
  id: string
  observedOn: Date
  capturedAt: Date
  releaseSha: string
  snapshotHash: string
  snapshot: unknown
  evidenceComplete: boolean
}

function utcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10)
}

function daysBetween(left: Date, right: Date) {
  return Math.round((utcDay(right).getTime() - utcDay(left).getTime()) / 86_400_000)
}

function hashSnapshot(snapshot: FounderAbsenceObservationSnapshot) {
  return createHash('sha256')
    .update('torchiko-founder-absence-observation-v1\0')
    .update(JSON.stringify(snapshot))
    .digest('hex')
}

export function applyFounderAbsenceObservationHistory<T extends CurrentReadiness>(
  current: T,
  rows: ObservationRow[],
  now = new Date(),
): ObservedReadiness<T> {
  const observations = [...rows]
    .sort((left, right) => left.observedOn.getTime() - right.observedOn.getTime())
    .filter(
      (row, index, values) =>
        index === 0 || dateKey(row.observedOn) !== dateKey(values[index - 1]!.observedOn),
    )
  let consecutiveDays = observations.at(-1)?.evidenceComplete ? 1 : 0
  for (let index = observations.length - 1; consecutiveDays > 0 && index > 0; index -= 1) {
    if (!observations[index - 1]!.evidenceComplete) break
    if (daysBetween(observations[index - 1]!.observedOn, observations[index]!.observedOn) !== 1)
      break
    consecutiveDays += 1
  }
  const latest = observations.at(-1) ?? null
  const observedDays = Math.min(consecutiveDays, 7)
  const observationState =
    observedDays === 0
      ? ('NOT_STARTED' as const)
      : observedDays >= 7
        ? ('READY_FOR_REVIEW' as const)
        : ('IN_PROGRESS' as const)
  const explanation =
    observationState === 'NOT_STARTED'
      ? 'A representative uninterrupted week has not been recorded. The daily observer has not retained its first sample.'
      : observationState === 'READY_FOR_REVIEW'
        ? 'Seven consecutive daily samples are retained. This is ready for human review, not automatically certified maturity.'
        : `${observedDays} of 7 consecutive daily samples are retained. Missing days reset the uninterrupted streak.`

  return {
    ...current,
    schemaVersion: 2 as const,
    target: {
      ordinaryOperationDays: 7 as const,
      launchGate: false as const,
      certification: 'NOT_CERTIFIED' as const,
      observationState,
      observedDays,
      explanation,
    },
    observationHistory: {
      retainedDays: observations.length,
      consecutiveDays,
      latestObservedOn: latest ? dateKey(latest.observedOn) : null,
      latestCapturedAt: latest?.capturedAt ?? null,
      latestReleaseSha: latest?.releaseSha ?? null,
      stale: latest ? daysBetween(latest.observedOn, now) > 1 : false,
      incompleteSamples: observations.filter((row) => !row.evidenceComplete).length,
      immutableDailySamples: true as const,
    },
    evidenceWindow: {
      ...current.evidenceWindow,
      historicalContinuityVerified: consecutiveDays >= 7,
    },
  } as ObservedReadiness<T>
}

export async function listFounderAbsenceObservations(take = 8) {
  return withTenantIsolationBypass(() =>
    db.founderAbsenceObservation.findMany({
      orderBy: [{ observedOn: 'desc' }],
      take,
      select: {
        id: true,
        observedOn: true,
        capturedAt: true,
        releaseSha: true,
        snapshotHash: true,
        snapshot: true,
        evidenceComplete: true,
      },
    }),
  )
}

function boundedPage<T>(rows: T[], limit: number) {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? { more: true } : null }
}

export async function readFounderAbsenceCurrentReadiness(now = new Date(), limit = 25) {
  return withTenantIsolationBypass(async () => {
    const take = limit + 1
    const [
      jobs,
      evaluations,
      approvals,
      support,
      questions,
      blockedAgents,
      events,
      platformEvents,
      actions,
      outcomes,
    ] = await Promise.all([
      db.jobRecord.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true },
      }),
      db.evalRun.findMany({
        where: {
          OR: [
            { status: { in: ['FAILED', 'STAGED', 'RETRY_SCHEDULED'] } },
            { status: 'RUNNING', executionLeaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, status: true, executionLeaseExpiresAt: true },
      }),
      db.approvalRequest.findMany({
        where: { decision: { is: null } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true },
      }),
      db.supportRequest.findMany({
        where: {
          status: {
            in: [
              'OPEN',
              'IN_REVIEW',
              'WAITING_FOR_CLIENT',
              'PATCH_DRAFTED',
              'VALIDATING',
              'AWAITING_APPROVAL',
              'APPLYING',
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, status: true },
      }),
      db.agentQuestion.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, agentRunId: true, blocking: true },
      }),
      db.agentRun.findMany({
        where: { status: { in: ['AWAITING_INPUT', 'AWAITING_APPROVAL', 'FAILED'] } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, status: true },
      }),
      db.operationalEvent.findMany({
        where: { state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, occurrenceCount: true },
      }),
      db.platformOperationalEvent.findMany({
        where: { state: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, occurrenceCount: true },
      }),
      db.agentAction.findMany({ orderBy: { createdAt: 'desc' }, take, select: { status: true } }),
      db.agentOutcomeObservation.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: { signalKind: true, verdict: true, relatedAgentActionId: true },
      }),
    ])
    const pageHasMore = actions.length > limit || outcomes.length > limit
    return deriveFounderAbsenceReadiness({
      generatedAt: now,
      jobs: boundedPage(jobs, limit),
      evaluations: boundedPage(
        evaluations.map((row) => ({
          id: row.id,
          status: row.status,
          expiredLease:
            row.status === 'RUNNING' &&
            row.executionLeaseExpiresAt !== null &&
            row.executionLeaseExpiresAt <= now,
        })),
        limit,
      ),
      approvals: boundedPage(approvals, limit),
      support: boundedPage(support, limit),
      questions: boundedPage(questions, limit),
      blockedAgents: boundedPage(blockedAgents, limit),
      events: boundedPage(events, limit),
      platformEvents: boundedPage(platformEvents, limit),
      agentTrustEvidence: {
        actions: {
          denied: actions.slice(0, limit).filter((row) => row.status === 'DENIED').length,
        },
        customerSignals: {
          negative: outcomes
            .slice(0, limit)
            .filter((row) => row.signalKind === 'CUSTOMER_SIGNAL' && row.verdict === 'NEGATIVE')
            .length,
        },
        rollbackEvidence: {
          distinctActions: new Set(
            outcomes
              .slice(0, limit)
              .filter((row) => row.signalKind === 'ROLLBACK')
              .flatMap((row) => (row.relatedAgentActionId ? [row.relatedAgentActionId] : [])),
          ).size,
        },
        policyViolationEvidence: {
          observations: outcomes
            .slice(0, limit)
            .filter((row) => row.signalKind === 'POLICY_VIOLATION').length,
        },
        boundedSnapshot: { hasMore: pageHasMore },
      },
    })
  })
}

export async function captureFounderAbsenceObservation(input: {
  readiness: CurrentReadiness
  releaseSha: string
  now?: Date
}) {
  const now = input.now ?? new Date()
  const releaseSha = input.releaseSha.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) throw new Error('releaseSha must be an exact SHA')
  const snapshot = founderAbsenceObservationSnapshotSchema.parse({
    schemaVersion: 1,
    summary: input.readiness.summary,
    dimensions: input.readiness.dimensions,
    evidenceWindow: {
      ...input.readiness.evidenceWindow,
      historicalContinuityVerified: false,
    },
  })
  const observedOn = utcDay(now)
  await withTenantIsolationBypass(() =>
    db.founderAbsenceObservation.createMany({
      data: [
        {
          observedOn,
          capturedAt: now,
          releaseSha,
          schemaVersion: 1,
          snapshotHash: hashSnapshot(snapshot),
          snapshot,
          evidenceComplete: snapshot.evidenceWindow.complete,
        },
      ],
      skipDuplicates: true,
    }),
  )
  const retained = await withTenantIsolationBypass(() =>
    db.founderAbsenceObservation.findUnique({ where: { observedOn } }),
  )
  if (!retained) throw new Error('Founder absence observation was not retained')
  return retained
}
