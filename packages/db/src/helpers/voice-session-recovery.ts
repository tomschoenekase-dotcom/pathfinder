import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

export const VOICE_SESSION_RECOVERY_BATCH_MAX = 250
export const VOICE_AUTHORIZATION_LEASE_SECONDS = 300

export type ExpiredVoiceSession = {
  id: string
  tenantId: string
  venueId: string
  visitorSessionId: string
  previousStatus: 'AUTHORIZING' | 'READY' | 'ACTIVE'
  durationSeconds: number
}

export type VoiceSessionHangupRecord = {
  id: string
  tenantId: string
  venueId: string
  visitorSessionId: string
  status: 'READY' | 'ACTIVE'
  providerSessionId: string | null
  errorCode: string | null
  createdAt: Date
  connectedAt: Date | null
  maxDurationSeconds: number
}

export async function loadVoiceSessionForHangup(
  voiceSessionId: string,
): Promise<VoiceSessionHangupRecord | null> {
  return withTenantIsolationBypass(() =>
    db.voiceSession.findFirst({
      where: { id: voiceSessionId, status: { in: ['READY', 'ACTIVE'] } },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        visitorSessionId: true,
        status: true,
        providerSessionId: true,
        errorCode: true,
        createdAt: true,
        connectedAt: true,
        maxDurationSeconds: true,
      },
    }),
  ) as Promise<VoiceSessionHangupRecord | null>
}

export async function findDueVoiceSessionHangups(options: {
  now: Date
  limit?: number
}): Promise<VoiceSessionHangupRecord[]> {
  const limit = options.limit ?? VOICE_SESSION_RECOVERY_BATCH_MAX
  if (!Number.isInteger(limit) || limit < 1 || limit > VOICE_SESSION_RECOVERY_BATCH_MAX) {
    throw new Error(
      `Voice session recovery limit must be an integer between 1 and ${VOICE_SESSION_RECOVERY_BATCH_MAX}.`,
    )
  }
  if (Number.isNaN(options.now.getTime()))
    throw new Error('Voice session recovery time must be valid.')

  return withTenantIsolationBypass(
    () => db.$queryRaw<VoiceSessionHangupRecord[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        venue_id AS "venueId",
        visitor_session_id AS "visitorSessionId",
        status::text AS status,
        provider_session_id AS "providerSessionId",
        error_code AS "errorCode",
        created_at AS "createdAt",
        connected_at AS "connectedAt",
        max_duration_seconds AS "maxDurationSeconds"
      FROM voice_sessions
      WHERE status IN ('READY', 'ACTIVE')
        AND provider_session_id ~ '^rtc_[A-Za-z0-9_-]+$'
        AND (
          (status = 'ACTIVE' AND error_code = 'PROVIDER_HANGUP_PENDING')
          OR COALESCE(connected_at, created_at) + (max_duration_seconds * INTERVAL '1 second') <= ${options.now}
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `,
  )
}

export async function finalizeExpiredVoiceSessionHangup(options: {
  voiceSessionId: string
  now: Date
}): Promise<ExpiredVoiceSession | null> {
  if (Number.isNaN(options.now.getTime()))
    throw new Error('Voice session recovery time must be valid.')
  const rows = await withTenantIsolationBypass(
    () => db.$queryRaw<ExpiredVoiceSession[]>`
      UPDATE voice_sessions AS session
      SET
        status = 'EXPIRED',
        ended_at = ${options.now},
        last_active_at = ${options.now},
        duration_seconds = CASE
          WHEN connected_at IS NULL THEN 0
          ELSE LEAST(
            max_duration_seconds,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (${options.now} - connected_at)))::integer)
          )
        END,
        fallback_to_text = TRUE,
        error_code = 'SERVER_SESSION_EXPIRED',
        updated_at = ${options.now}
      WHERE id = ${options.voiceSessionId}::uuid
        AND status IN ('READY', 'ACTIVE')
        AND provider_session_id ~ '^rtc_[A-Za-z0-9_-]+$'
        AND (
          (status = 'ACTIVE' AND error_code = 'PROVIDER_HANGUP_PENDING')
          OR COALESCE(connected_at, created_at) + (max_duration_seconds * INTERVAL '1 second') <= ${options.now}
        )
      RETURNING
        session.id,
        session.tenant_id AS "tenantId",
        session.venue_id AS "venueId",
        session.visitor_session_id AS "visitorSessionId",
        'ACTIVE'::text AS "previousStatus",
        session.duration_seconds AS "durationSeconds"
    `,
  )
  return rows[0] ?? null
}

/**
 * Atomically releases abandoned voice capacity without extending product policy.
 * READY follows the provider credential's own expiry; ACTIVE follows the session's
 * persisted entitlement snapshot. The short AUTHORIZING lease only recovers an API
 * process that died before it could persist provider authorization or failure.
 */
export async function expireAbandonedVoiceSessions(
  options: { now?: Date; limit?: number } = {},
): Promise<ExpiredVoiceSession[]> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? VOICE_SESSION_RECOVERY_BATCH_MAX
  if (!Number.isInteger(limit) || limit < 1 || limit > VOICE_SESSION_RECOVERY_BATCH_MAX) {
    throw new Error(
      `Voice session recovery limit must be an integer between 1 and ${VOICE_SESSION_RECOVERY_BATCH_MAX}.`,
    )
  }
  if (Number.isNaN(now.getTime())) throw new Error('Voice session recovery time must be valid.')

  return withTenantIsolationBypass(
    () =>
      db.$queryRaw<ExpiredVoiceSession[]>`
      WITH candidates AS (
        SELECT
          id,
          status AS previous_status
        FROM voice_sessions
        WHERE
          (
            status = 'AUTHORIZING'
            AND created_at <= ${now} - (${VOICE_AUTHORIZATION_LEASE_SECONDS} * INTERVAL '1 second')
          )
          OR (
            status = 'READY'
            AND (
              client_secret_expires_at <= ${now}
              OR (
                client_secret_expires_at IS NULL
                AND created_at <= ${now} - (${VOICE_AUTHORIZATION_LEASE_SECONDS} * INTERVAL '1 second')
              )
            )
          )
          OR (
            status = 'ACTIVE'
            AND connected_at IS NOT NULL
            AND (provider_session_id IS NULL OR provider_session_id !~ '^rtc_[A-Za-z0-9_-]+$')
            AND connected_at + (max_duration_seconds * INTERVAL '1 second') <= ${now}
          )
        ORDER BY created_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE voice_sessions AS session
      SET
        status = 'EXPIRED',
        ended_at = ${now},
        last_active_at = ${now},
        duration_seconds = CASE
          WHEN connected_at IS NULL THEN 0
          ELSE LEAST(
            max_duration_seconds,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (${now} - connected_at)))::integer)
          )
        END,
        fallback_to_text = TRUE,
        error_code = 'SERVER_SESSION_EXPIRED',
        updated_at = ${now}
      FROM candidates
      WHERE session.id = candidates.id
        AND session.status = candidates.previous_status
      RETURNING
        session.id,
        session.tenant_id AS "tenantId",
        session.venue_id AS "venueId",
        session.visitor_session_id AS "visitorSessionId",
        candidates.previous_status::text AS "previousStatus",
        session.duration_seconds AS "durationSeconds"
    `,
  )
}
