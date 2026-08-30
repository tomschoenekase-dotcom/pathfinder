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
        duration_seconds = LEAST(
          max_duration_seconds,
          GREATEST(
            0,
            ROUND(EXTRACT(EPOCH FROM (${now} - COALESCE(connected_at, created_at))))::integer
          )
        ),
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
