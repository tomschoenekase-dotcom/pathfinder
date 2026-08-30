import { logger } from '@pathfinder/config'
import {
  db,
  isEvaluationRuntimeDurablyEnabled,
  markEvaluationRunQueued,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import {
  enqueueEvaluationRun,
  EVALUATION_RUN_DISPATCH_JOB,
  EVALUATION_RUN_QUEUE,
  type EvaluationRunJobPayload,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

const DISPATCH_BATCH_LIMIT = 100
const TENANT_FLAG = 'evaluation-runner-v1'

type Candidate = EvaluationRunJobPayload & {
  status: 'STAGED' | 'QUEUED' | 'RETRY_SCHEDULED' | 'RUNNING'
  attemptNumber: number
  executionLeaseToken: string | null
}

export type EvaluationDispatchDependencies = {
  globalEnabled(): Promise<boolean>
  listCandidates(): Promise<Candidate[]>
  tenantEnabled(tenantId: string): Promise<boolean>
  markQueued(candidate: Candidate): Promise<boolean>
  enqueue(candidate: Candidate): Promise<{ enqueued: boolean }>
}

function defaultDependencies(): EvaluationDispatchDependencies {
  return {
    globalEnabled: () => isEvaluationRuntimeDurablyEnabled(db),
    listCandidates: () =>
      withTenantIsolationBypass(() =>
        db.evalRun.findMany({
          where: {
            OR: [
              { status: { in: ['STAGED', 'QUEUED', 'RETRY_SCHEDULED'] } },
              { status: 'RUNNING', executionLeaseExpiresAt: { lte: new Date() } },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: DISPATCH_BATCH_LIMIT,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            identityHash: true,
            status: true,
            attemptNumber: true,
            executionLeaseToken: true,
          },
        }),
      ).then((rows) =>
        rows.map((row) => ({
          tenantId: row.tenantId,
          venueId: row.venueId,
          runId: row.id,
          runIdentityHash: row.identityHash,
          status: row.status as Candidate['status'],
          attemptNumber: row.attemptNumber,
          executionLeaseToken: row.executionLeaseToken,
        })),
      ),
    tenantEnabled: (tenantId) =>
      withTenantIsolationBypass(() =>
        db.tenantFeatureFlag.findUnique({
          where: { tenantId_flagKey: { tenantId, flagKey: TENANT_FLAG } },
          select: { enabled: true },
        }),
      ).then((flag) => flag?.enabled === true),
    markQueued: (candidate) => markEvaluationRunQueued(candidate),
    enqueue: (candidate) =>
      enqueueEvaluationRun(candidate, {
        enabled: true,
        dispatchKey:
          candidate.status === 'RUNNING'
            ? `lease-recovery-${candidate.attemptNumber}-${candidate.executionLeaseToken ?? 'missing'}`
            : `attempt-${candidate.attemptNumber + 1}`,
      }),
  }
}

/** Reconciles durable STAGED/QUEUED state with the deterministic BullMQ job ID.
 * QUEUED rows are intentionally republished: BullMQ add is idempotent, and this
 * repairs a crash between the state transition and queue publication. */
export async function dispatchStagedEvaluationRuns(
  deps: EvaluationDispatchDependencies = defaultDependencies(),
): Promise<{ scanned: number; published: number; failed: number }> {
  if (!(await deps.globalEnabled())) return { scanned: 0, published: 0, failed: 0 }
  const candidates = await deps.listCandidates()
  let published = 0
  let failed = 0
  for (const candidate of candidates) {
    if (!(await deps.tenantEnabled(candidate.tenantId))) continue
    if (candidate.status === 'STAGED' && !(await deps.markQueued(candidate))) continue
    try {
      const result = await deps.enqueue(candidate)
      if (!result.enqueued) throw new Error('Evaluation queue publication was not confirmed')
      published += 1
    } catch (error) {
      failed += 1
      logger.error({
        action: 'evaluation.dispatch.failed',
        tenantId: candidate.tenantId,
        venueId: candidate.venueId,
        runId: candidate.runId,
        error: error instanceof Error ? error.message : 'Unknown dispatch error',
      })
    }
  }
  return { scanned: candidates.length, published, failed }
}

export async function processEvaluationDispatchJob(
  executionInput?: JobExecutionInput,
): Promise<void> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: EVALUATION_RUN_QUEUE,
    jobName: EVALUATION_RUN_DISPATCH_JOB,
    bullJobId: execution.bullJobId ?? null,
    status: 'RUNNING',
    payload: {},
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  try {
    const result = await dispatchStagedEvaluationRuns()
    if (result.failed > 0) throw new Error('One or more evaluation runs were not published')
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
  } catch (error) {
    await recordJobFailure({
      jobRecordId,
      error,
      execution,
    })
    throw error
  }
}
