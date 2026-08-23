import type { TRPCContext } from '../context'

export async function loadPublicLocationScope(
  db: TRPCContext['db'],
  input: { anonymousToken: string; venueId: string },
) {
  // Deliberate public cross-tenant lookup: venue and anonymous token are joined
  // before any tenant-scoped structured location lookup is attempted.
  const [scope] = await db.$queryRaw<
    Array<{ tenantId: string; venueId: string; experienceScope: string }>
  >`
    SELECT s.tenant_id AS "tenantId", s.venue_id AS "venueId", s.experience_scope AS "experienceScope"
      FROM visitor_sessions s
      JOIN venues v ON v.id = s.venue_id AND v.tenant_id = s.tenant_id
     WHERE s.anonymous_token = ${input.anonymousToken}
       AND s.venue_id = ${input.venueId}
       AND v.is_active = true
     LIMIT 1
  `
  return scope?.experienceScope === 'PUBLIC' ? scope : null
}
