import { logger } from '@pathfinder/config'
import {
  discoverExpiredGenerationExecutions,
  GENERATION_RECOVERY_MAX_PER_TYPE,
  updateJobRecord,
  writeJobRecord,
} from '@pathfinder/db'
import {
  enqueueAnswerAnalysisRecovery,
  enqueueWeeklyReportRecovery,
  GENERATION_RECOVERY_QUEUE,
  GENERATION_RECOVERY_SCHEDULER_JOB,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

export type GenerationRecoveryResult = {
  discovered: number
  enqueueRequestsAccepted: number
  failed: number
}

export async function processGenerationRecovery(
  executionInput?: JobExecutionInput,
): Promise<GenerationRecoveryResult> {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: GENERATION_RECOVERY_QUEUE,
    jobName: GENERATION_RECOVERY_SCHEDULER_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: null,
    status: 'RUNNING',
    payload: { limitPerType: GENERATION_RECOVERY_MAX_PER_TYPE },
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  let discovered = 0
  let enqueueRequestsAccepted = 0
  let failed = 0

  try {
    const candidates = await discoverExpiredGenerationExecutions()
    discovered = candidates.answerAnalyses.length + candidates.weeklyReports.length

    for (const candidate of candidates.answerAnalyses) {
      try {
        await enqueueAnswerAnalysisRecovery(
          {
            tenantId: candidate.tenantId,
            venueId: candidate.venueId,
            snapshotId: candidate.snapshotId,
            rangeStart: candidate.rangeStart.toISOString(),
            rangeEnd: candidate.rangeEnd.toISOString(),
          },
          candidate.executionLeaseToken,
        )
        enqueueRequestsAccepted += 1
      } catch {
        failed += 1
        logger.error({
          action: 'workers.generation-recovery.enqueue-failed',
          generationType: 'answer-analysis',
          tenantId: candidate.tenantId,
          venueId: candidate.venueId,
          recordId: candidate.snapshotId,
          reason: 'queue-enqueue-failed',
          error: 'Generation recovery enqueue failed.',
        })
      }
    }

    for (const candidate of candidates.weeklyReports) {
      try {
        await enqueueWeeklyReportRecovery(
          {
            tenantId: candidate.tenantId,
            venueId: candidate.venueId,
            reportId: candidate.reportId,
            weekStart: candidate.weekStart.toISOString(),
            weekEnd: candidate.weekEnd.toISOString(),
          },
          candidate.executionLeaseToken,
        )
        enqueueRequestsAccepted += 1
      } catch {
        failed += 1
        logger.error({
          action: 'workers.generation-recovery.enqueue-failed',
          generationType: 'weekly-report',
          tenantId: candidate.tenantId,
          venueId: candidate.venueId,
          recordId: candidate.reportId,
          reason: 'queue-enqueue-failed',
          error: 'Generation recovery enqueue failed.',
        })
      }
    }

    if (failed > 0) {
      throw new Error(`Failed to enqueue ${failed} generation recovery candidate(s).`)
    }

    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: 'workers.generation-recovery.completed',
      discovered,
      enqueueRequestsAccepted,
      failed,
    })
    return { discovered, enqueueRequestsAccepted, failed }
  } catch (error) {
    await recordJobFailure({
      jobRecordId,
      error,
      execution,
    })
    logger.error({
      action: 'workers.generation-recovery.failed',
      discovered,
      enqueueRequestsAccepted,
      failed,
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      reason: 'generation-recovery-run-failed',
      error: 'Generation recovery run failed.',
    })
    throw toQueueSafeJobError(error, 'GENERATION_RECOVERY_FAILED')
  }
}
