import { notFound } from 'next/navigation'

import {
  isVenueQrKitAvailable,
  VenueQrKitAvailability,
} from '../../../../../components/VenueQrKitAvailability'
import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'
import { getChatPalette } from '@pathfinder/ui/theme'

import { GuideSharingDetails } from '../../../../../components/portal/GuideSharingDetails'
import {
  buildGuestChatUrl,
  buildSecondLayerChatUrl,
  resolveGuestWebOrigin,
} from '../../../../../lib/guest-chat-url'
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
    >
      {available ? await sharingDetails(caller, venue) : null}
    </VenueQrKitAvailability>
  )
}

type DashboardCaller = Awaited<ReturnType<typeof createDashboardCaller>>

// Website, app and staff-link details moved here from Home. They are secondary, so any read
// failure omits them instead of blocking the QR code.
async function sharingDetails(caller: DashboardCaller, venue: { id: string; slug: string }) {
  try {
    const guideOrigin = resolveGuestWebOrigin(
      process.env.NEXT_PUBLIC_WEB_URL,
      process.env.RAILWAY_ENVIRONMENT,
    )
    const allowLoopbackHttp = process.env.NODE_ENV === 'development'
    const [distribution, secondLayer] = await Promise.all([
      caller.tenant.venueDistribution.readback({ venueId: venue.id }).catch(() => null),
      caller.venue.getSecondLayer({ venueId: venue.id }).catch(() => null),
    ])
    const artifacts =
      distribution &&
      buildVenueAccessArtifacts(process.env.NEXT_PUBLIC_WEB_URL, venue.slug, {
        allowLoopbackHttp,
        appBackground: getChatPalette(
          distribution.venue.chatTheme,
          distribution.venue.chatAccentColor,
        ).bg,
      })
    return (
      <GuideSharingDetails
        venueId={venue.id}
        distribution={
          distribution
            ? {
                website: distribution.website,
                app: distribution.app,
                appUrl: artifacts?.appUrl ?? null,
                appBackground: artifacts?.appBackground ?? null,
              }
            : null
        }
        secondLayer={
          secondLayer
            ? {
                enabled: secondLayer.secondLayerEnabled,
                label: secondLayer.secondLayerLabel,
                updatedAt: secondLayer.updatedAt.toISOString(),
                url: secondLayer.secondLayerEnabled
                  ? buildSecondLayerChatUrl(
                      guideOrigin,
                      secondLayer.slug,
                      secondLayer.secondLayerAccessKey,
                      { allowLoopbackHttp },
                    )
                  : null,
              }
            : null
        }
      />
    )
  } catch {
    return null
  }
}
