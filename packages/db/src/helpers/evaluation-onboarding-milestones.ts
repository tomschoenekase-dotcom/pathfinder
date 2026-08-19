import { randomUUID } from 'node:crypto'

import { db } from '../client'
import { recordOrReplayOnboardingMilestoneEvent } from './onboarding-milestone-events'

type Client = {
  evalRun: {
    findFirst(args: unknown): Promise<{
      id: string
      tenantId: string
      venueId: string
      identityHash: string
      contentSnapshotKind: string
      status: string
      startedAt: Date | null
      completedAt: Date | null
    } | null>
  }
  evalResult: {
    findMany(args: unknown): Promise<
      {
        id: string
        outcome: string
        passed: boolean | null
        evalCase: { category: string }
      }[]
    >
  }
  onboardingMilestoneEvent: Parameters<
    typeof recordOrReplayOnboardingMilestoneEvent
  >[0]['db']['onboardingMilestoneEvent']
}

export async function recordApprovedPackageEvaluationMilestones(
  scope: { runId: string; tenantId: string; venueId: string; runIdentityHash: string },
  client: Client = db as unknown as Client,
): Promise<{ eligible: boolean; recorded: number }> {
  const run = await client.evalRun.findFirst({
    where: {
      id: scope.runId,
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      identityHash: scope.runIdentityHash,
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      identityHash: true,
      contentSnapshotKind: true,
      status: true,
      startedAt: true,
      completedAt: true,
    },
  })
  if (
    !run ||
    run.contentSnapshotKind !== 'APPROVED_VENUE_PACKAGE_V1' ||
    !['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) ||
    !run.completedAt
  )
    return { eligible: false, recorded: 0 }

  const results = await client.evalResult.findMany({
    where: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      runId: scope.runId,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 50,
    select: {
      id: true,
      outcome: true,
      passed: true,
      evalCase: { select: { category: true } },
    },
  })
  const durationMs = run.startedAt
    ? Math.min(2_147_483_647, Math.max(0, run.completedAt.getTime() - run.startedAt.getTime()))
    : null
  let recorded = 0
  for (const result of results) {
    const passed = result.outcome === 'SCORED' && result.passed === true
    await recordOrReplayOnboardingMilestoneEvent({
      db: client,
      input: {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        eventType: 'QA_RESULT',
        idempotencyKey: `evaluation-result:${result.id}`,
        occurredAt: run.completedAt,
        actorType: 'SYSTEM',
        actorId: null,
        sourceType: 'EVALUATION_RESULT',
        sourceId: result.id,
        sourceRevision: run.identityHash,
        category: `${result.evalCase.category.toUpperCase()}:${passed ? 'PASSED' : 'FAILED'}`,
        durationMs,
      },
    })
    recorded += 1
  }
  if (results.length === 0 && run.status !== 'COMPLETED') {
    await recordOrReplayOnboardingMilestoneEvent({
      db: client,
      input: {
        id: randomUUID(),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        eventType: 'PROCESSING_FAILED',
        idempotencyKey: `evaluation-run:${run.id}:${run.status}`,
        occurredAt: run.completedAt,
        actorType: 'SYSTEM',
        actorId: null,
        sourceType: 'EVALUATION_RUN',
        sourceId: run.id,
        sourceRevision: run.identityHash,
        category: `EVALUATION_${run.status}`,
        durationMs,
      },
    })
    recorded += 1
  }
  return { eligible: true, recorded }
}
