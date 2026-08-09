import { db } from '../client'
import { assertGlobalAiAvailable } from './incident-control'

type VenueAvailabilityClient = Pick<typeof db, 'venue'>
type VenueAiAvailabilityClient = VenueAvailabilityClient &
  Parameters<typeof assertGlobalAiAvailable>[0]

export class VenueUnavailableError extends Error {
  readonly code = 'VENUE_UNAVAILABLE'

  constructor() {
    super('Venue is unavailable')
    this.name = 'VenueUnavailableError'
  }
}

export async function assertVenueAvailable(
  client: VenueAvailabilityClient,
  input: { tenantId: string; venueId: string },
): Promise<void> {
  let venue: { isActive: boolean } | null
  try {
    venue = await client.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { isActive: true },
    })
  } catch {
    throw new VenueUnavailableError()
  }

  if (!venue?.isActive) throw new VenueUnavailableError()
}

export async function assertVenueAiAvailable(
  client: VenueAiAvailabilityClient,
  input: { tenantId: string; venueId: string },
): Promise<void> {
  await assertGlobalAiAvailable(client)
  await assertVenueAvailable(client, input)
}

export function isVenueUnavailableError(error: unknown): error is VenueUnavailableError {
  return error instanceof VenueUnavailableError
}
