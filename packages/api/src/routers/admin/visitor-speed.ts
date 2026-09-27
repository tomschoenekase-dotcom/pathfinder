import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

type VisitorSpeedSqlRow = {
  tenantId: string
  venueId: string
  venueName: string
  sampleCount: number
  p50RequestFirstTextMs: number
  p90RequestFirstTextMs: number
}

const VISITOR_SPEED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export const adminVisitorSpeedRouter = router({
  getVisitorSpeed: adminProcedure.query(async () => {
    const windowEnd = new Date()
    const windowStart = new Date(windowEnd.getTime() - VISITOR_SPEED_WINDOW_MS)

    // The platform-wide read is admin-only; joining tenant+venue keys preserves the
    // AnalyticsEvent composite ownership relation, and the rolling timestamp uses its index.
    const venues = await withTenantIsolationBypass(
      () =>
        db.$queryRaw<VisitorSpeedSqlRow[]>`
        SELECT
          event.tenant_id AS "tenantId",
          event.venue_id AS "venueId",
          venue.name AS "venueName",
          COUNT(*)::int AS "sampleCount",
          percentile_cont(0.5) WITHIN GROUP (ORDER BY timing.request_first_text_ms)
            AS "p50RequestFirstTextMs",
          percentile_cont(0.9) WITHIN GROUP (ORDER BY timing.request_first_text_ms)
            AS "p90RequestFirstTextMs"
        FROM analytics_events AS event
        JOIN venues AS venue
          ON venue.id = event.venue_id
         AND venue.tenant_id = event.tenant_id
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN jsonb_typeof(event.metadata->'requestFirstTextMs') = 'number'
            THEN (event.metadata->>'requestFirstTextMs')::double precision
            ELSE NULL
          END AS request_first_text_ms
        ) AS timing
        WHERE event.event_type = 'message.received'
          AND event.occurred_at >= ${windowStart}
          AND event.occurred_at < ${windowEnd}
          AND timing.request_first_text_ms >= 0
        GROUP BY event.tenant_id, event.venue_id, venue.name
        ORDER BY venue.name, event.tenant_id, event.venue_id
      `,
    )

    return { windowStart, windowEnd, venues }
  }),
})
