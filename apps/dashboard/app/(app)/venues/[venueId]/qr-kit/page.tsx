import { notFound } from 'next/navigation'

import {
  isVenueQrKitAvailable,
  VenueQrKitAvailability,
} from '../../../../../components/VenueQrKitAvailability'
import { buildGuestChatUrl, resolveGuestWebOrigin } from '../../../../../lib/guest-chat-url'
import { createDashboardCaller } from '../../../../../lib/server-caller'

export default async function VenueQrKitPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  const caller = await createDashboardCaller(`/venues/${venueId}/qr-kit`)
  const [venues, lifecycles] = await Promise.all([
    caller.venue.list(),
    caller.portal.getVenueLifecycles(),
  ])
  const venue = venues.find((candidate) => candidate.id === venueId)
  const lifecycle = lifecycles.find((candidate) => candidate.venueId === venueId)
  if (!venue || !lifecycle) notFound()

  const eligibleLifecycle = ['READY', 'LIVE', 'REVISIONS'].includes(lifecycle.lifecycle.state)
  const venueAsset = eligibleLifecycle ? await caller.portal.getVenueLaunchAsset({ venueId }) : null

  const candidateGuestChatUrl = venueAsset
    ? buildGuestChatUrl(
        resolveGuestWebOrigin(process.env.NEXT_PUBLIC_WEB_URL, process.env.RAILWAY_ENVIRONMENT),
        venue.slug,
      )
    : null
  const available = isVenueQrKitAvailable(
    lifecycle.lifecycle.state,
    candidateGuestChatUrl,
    venueAsset !== null,
  )
  const guestChatUrl = available ? candidateGuestChatUrl : null
  return (
    <VenueQrKitAvailability
      venueId={venue.id}
      venueName={venue.name}
      lifecycleState={lifecycle.lifecycle.state}
      hasCurrentRelease={venueAsset !== null}
      guestChatUrl={guestChatUrl}
      generatedAt={new Date().toISOString()}
      venueAsset={venueAsset}
    />
  )
}
