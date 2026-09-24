import { createLocalProspectResearchReader } from '@pathfinder/api/prospect-research-reader'
import { localFirstSendRehearsalEnabled } from '@pathfinder/db'

import { isLocalProspectResearchRequest } from '../../../../../lib/local-prospect-research-boundary'

export const dynamic = 'force-dynamic'
const syntheticOrganization = /^SYN-CRM-FIRSTSEND-ORG-r\d+$/
const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
}
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers })

function isNotFound(error: unknown) {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'NOT_FOUND',
  )
}

/** Narrow read projection: no normal organization ID can reach the local reader from this fixture. */
export async function GET(request: Request) {
  if (!isLocalProspectResearchRequest(request.headers) || !localFirstSendRehearsalEnabled())
    return reply({ error: 'Not found' }, 404)
  const organizationId = new URL(request.url).searchParams.get('organizationId')
  if (!organizationId || !syntheticOrganization.test(organizationId))
    return reply({ error: 'Not found' }, 404)
  try {
    const record = await createLocalProspectResearchReader().detail({ organizationId })
    if (!record)
      return reply(
        { error: 'Synthetic record is not present in the local rehearsal database' },
        404,
      )
    return reply({
      id: record.id,
      canonicalName: record.canonicalName,
      venues: record.venues.map((venue) => ({
        id: venue.id,
        name: venue.name,
        archivedAt: venue.archivedAt,
      })),
    })
  } catch (error) {
    // Only an owner-confirmed missing record is a partial-selection state. A service failure stays unavailable.
    if (isNotFound(error))
      return reply(
        { error: 'Synthetic record is not present in the local rehearsal database' },
        404,
      )
    return reply(
      { error: 'Synthetic CRM record read is unavailable; retry without changing the selection' },
      503,
    )
  }
}
