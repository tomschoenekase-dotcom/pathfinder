import { emitEvent } from '@pathfinder/analytics'
import { logger } from '@pathfinder/config'
import {
  expireAbandonedVoiceSessions,
  updateJobRecord,
  VOICE_SESSION_RECOVERY_BATCH_MAX,
  writeJobRecord,
} from '@pathfinder/db'
import {
  VOICE_SESSION_RECOVERY_QUEUE,
  VOICE_SESSION_RECOVERY_SCHEDULER_JOB,
} from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

export async function processVoiceSessionRecovery(executionInput?: JobExecutionInput) {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: VOICE_SESSION_RECOVERY_QUEUE,
    jobName: VOICE_SESSION_RECOVERY_SCHEDULER_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: null,
    status: 'RUNNING',
    payload: { limit: VOICE_SESSION_RECOVERY_BATCH_MAX },
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  try {
    const expired = await expireAbandonedVoiceSessions({ now: startedAt })
    for (const session of expired) {
      await emitEvent({
        tenantId: session.tenantId,
        venueId: session.venueId,
        sessionId: session.visitorSessionId,
        eventType: 'voice.session.failed',
        occurredAt: startedAt,
        metadata: {
          voiceSessionId: session.id,
          failureStage: 'server-expiration',
          previousStatus: session.previousStatus,
          durationSeconds: session.durationSeconds,
          fallbackToText: true,
        },
      })
    }
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: 'workers.voice-session-recovery.completed',
      expired: expired.length,
      batchLimit: VOICE_SESSION_RECOVERY_BATCH_MAX,
    })
    return { expired: expired.length }
  } catch (error) {
    await recordJobFailure({
      jobRecordId,
      error,
      execution,
    })
    logger.error({
      action: 'workers.voice-session-recovery.failed',
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      error: 'Voice session recovery run failed.',
    })
    throw toQueueSafeJobError(error, 'VOICE_SESSION_RECOVERY_FAILED')
  }
}
