import { emitEvent } from '@pathfinder/analytics'
import { logger } from '@pathfinder/config'
import {
  expireAbandonedVoiceSessions,
  findDueVoiceSessionHangups,
  updateJobRecord,
  VOICE_SESSION_RECOVERY_BATCH_MAX,
  writeJobRecord,
} from '@pathfinder/db'
import { hangupDueVoiceSession } from './voice-session-hangup'
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
  let providerHangupFailures = 0

  try {
    const dueProviderSessions = await findDueVoiceSessionHangups({ now: startedAt })
    let providerExpired = 0
    for (const session of dueProviderSessions) {
      try {
        const expiredProviderSession = await hangupDueVoiceSession(session.id, { now: startedAt })
        if (expiredProviderSession) providerExpired += 1
      } catch {
        // Keep processing this bounded batch. The failed session remains due and
        // will be retried by the next recovery run or this job's retry.
        providerHangupFailures += 1
      }
    }
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
    if (providerHangupFailures > 0) {
      throw new Error('One or more due voice sessions failed provider hangup.')
    }
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    logger.info({
      action: 'workers.voice-session-recovery.completed',
      expired: expired.length + providerExpired,
      batchLimit: VOICE_SESSION_RECOVERY_BATCH_MAX,
    })
    return { expired: expired.length + providerExpired }
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
      providerHangupFailures,
      error: 'Voice session recovery run failed.',
    })
    throw toQueueSafeJobError(error, 'VOICE_SESSION_RECOVERY_FAILED')
  }
}
