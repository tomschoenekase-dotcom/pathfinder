import { hangupOpenAiRealtimeCall } from '@pathfinder/ai'
import { emitEvent } from '@pathfinder/analytics'
import { logger } from '@pathfinder/config'
import {
  finalizeExpiredVoiceSessionHangup,
  loadVoiceSessionForHangup,
  updateJobRecord,
  writeJobRecord,
} from '@pathfinder/db'
import { VOICE_SESSION_HANGUP_JOB, VOICE_SESSION_RECOVERY_QUEUE } from '@pathfinder/jobs'
import type { VoiceSessionHangupJobPayload } from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  toQueueSafeJobError,
  type JobExecutionInput,
} from '../lib/job-execution'

const OPENAI_CALL_ID_PATTERN = /^rtc_[A-Za-z0-9_-]+$/u

function parseDeadline(value: string): Date {
  const deadlineAt = new Date(value)
  if (Number.isNaN(deadlineAt.getTime()) || deadlineAt.toISOString() !== value) {
    throw new Error('Voice session hangup deadline is invalid.')
  }
  return deadlineAt
}

function sessionDeadline(session: {
  createdAt: Date
  connectedAt: Date | null
  maxDurationSeconds: number
}) {
  const startedAt = session.connectedAt ?? session.createdAt
  return new Date(startedAt.getTime() + session.maxDurationSeconds * 1_000)
}

export async function hangupDueVoiceSession(
  voiceSessionId: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
) {
  const now = options.now ?? new Date()
  if (Number.isNaN(now.getTime())) throw new Error('Voice session hangup clock is invalid.')
  const session = await loadVoiceSessionForHangup(voiceSessionId)
  if (!session) return null

  const deadlineAt = sessionDeadline(session)
  const hangupPending =
    session.status === 'ACTIVE' && session.errorCode === 'PROVIDER_HANGUP_PENDING'
  if (!hangupPending && now.getTime() < deadlineAt.getTime()) return null
  const callId = session.providerSessionId
  if (!callId || !OPENAI_CALL_ID_PATTERN.test(callId)) {
    throw new Error('Voice session is due but has no valid provider call ID.')
  }
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Realtime voice provider is not configured.')

  await hangupOpenAiRealtimeCall({
    apiKey,
    callId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const expired = await finalizeExpiredVoiceSessionHangup({ voiceSessionId, now })
  if (!expired) return null

  await emitEvent({
    tenantId: expired.tenantId,
    venueId: expired.venueId,
    sessionId: expired.visitorSessionId,
    eventType: 'voice.session.failed',
    occurredAt: now,
    metadata: {
      voiceSessionId: expired.id,
      failureStage: 'server-expiration',
      previousStatus: expired.previousStatus,
      durationSeconds: expired.durationSeconds,
      fallbackToText: true,
    },
  })
  return expired
}

export async function processVoiceSessionHangup(
  payload: VoiceSessionHangupJobPayload,
  executionInput?: JobExecutionInput,
  dependencies: { now?: () => Date; fetchImpl?: typeof fetch } = {},
) {
  const execution = normalizeJobExecutionMetadata(executionInput)
  const startedAt = new Date()
  const jobRecordId = await writeJobRecord({
    queue: VOICE_SESSION_RECOVERY_QUEUE,
    jobName: VOICE_SESSION_HANGUP_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: null,
    status: 'RUNNING',
    payload: { voiceSessionId: payload.voiceSessionId },
    startedAt,
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })

  try {
    const deadlineAt = parseDeadline(payload.deadlineAt)
    const now = dependencies.now?.() ?? new Date()
    if (Number.isNaN(now.getTime())) throw new Error('Voice session hangup clock is invalid.')
    const session = await loadVoiceSessionForHangup(payload.voiceSessionId)
    if (!session) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return { expired: false, reason: 'session-not-active' as const }
    }
    const hangupPending =
      session.status === 'ACTIVE' && session.errorCode === 'PROVIDER_HANGUP_PENDING'
    const persistedDeadline = sessionDeadline(session)
    if (!hangupPending && persistedDeadline.getTime() !== deadlineAt.getTime()) {
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return { expired: false, reason: 'stale-deadline' as const }
    }
    if (!hangupPending && now.getTime() < persistedDeadline.getTime()) {
      throw new Error('Voice session hangup job ran before its persisted deadline.')
    }
    const expired = await hangupDueVoiceSession(payload.voiceSessionId, {
      now,
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    return {
      expired: expired !== null,
      reason: expired ? ('expired' as const) : ('session-not-active' as const),
    }
  } catch (error) {
    await recordJobFailure({ jobRecordId, error, execution })
    logger.error({
      action: 'workers.voice-session-hangup.failed',
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
      error: 'Voice session provider hangup failed.',
    })
    throw toQueueSafeJobError(error, 'VOICE_SESSION_HANGUP_FAILED')
  }
}
