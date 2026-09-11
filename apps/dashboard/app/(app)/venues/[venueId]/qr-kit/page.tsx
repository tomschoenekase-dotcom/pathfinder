import { notFound } from 'next/navigation'

import {
  isVenueQrKitAvailable,
  VenueQrKitAvailability,
} from '../../../../../components/VenueQrKitAvailability'
import { buildGuestChatUrl } from '../../../../../lib/guest-chat-url'
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

  const candidateGuestChatUrl = buildGuestChatUrl(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
    allowLoopbackHttp: process.env.NODE_ENV === 'development',
  })
  const available = isVenueQrKitAvailable(
    lifecycle.lifecycle.state,
    candidateGuestChatUrl,
    lifecycle.release.released,
  )
  const guestChatUrl = available ? candidateGuestChatUrl : null
  const guideItems = available
    ? (await caller.place.list({ venueId }))
        .filter((place) => place.isActive && place.visibility === 'PUBLIC')
        .map((place) => ({
          id: place.id,
          name: place.name,
          updatedAt: place.updatedAt.toISOString(),
        }))
    : []

  return (
    <VenueQrKitAvailability
      venueId={venue.id}
      venueName={venue.name}
      lifecycleState={lifecycle.lifecycle.state}
      hasCurrentRelease={lifecycle.release.released}
      guestChatUrl={guestChatUrl}
      generatedAt={new Date().toISOString()}
      guideItems={guideItems}
    />
  )
}
