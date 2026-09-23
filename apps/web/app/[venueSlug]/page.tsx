import { notFound } from 'next/navigation'
import { appRouter, createTRPCContext } from '@pathfinder/api'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import { VenueArrival, type VenueArrivalSummary } from '../../components/VenueArrival'
import { VenueTemporarilyUnavailable } from '../../components/VenueTemporarilyUnavailable'
import { classifyPublicVenueLookupError } from '../../lib/public-venue-error'

type VenueLandingPageProps = {
  params: Promise<{
    venueSlug: string
  }>
}

type VenueSummary = VenueArrivalSummary & {
  id: string
  name: string
  description: string | null
  category: string | null
  defaultCenterLat: number | null
  defaultCenterLng: number | null
}

type VenueLookup =
  | {
      status: 'ready'
      venue: VenueSummary
      media: PublicVenueMediaItem[]
      mediaStatus: 'ready' | 'unavailable'
    }
  | { status: 'not-found' }
  | { status: 'temporarily-unavailable' }

async function loadVenue(slug: string): Promise<VenueLookup> {
  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/${slug}`),
  })

  try {
    const caller = appRouter.createCaller(ctx)
    // Both public reads depend on the slug, not on one another. A media outage
    // remains optional and never changes the venue's admission decision.
    const [venue, media] = await Promise.all([
      caller.venue.getBySlug({ slug }),
      caller.venue.mediaBySlug({ slug }).then(
        (result) => ({ items: result.items, status: 'ready' as const }),
        () => ({ items: [] as PublicVenueMediaItem[], status: 'unavailable' as const }),
      ),
    ])
    return { status: 'ready', venue, media: media.items, mediaStatus: media.status }
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    if (failure === 'not-found' || failure === 'temporarily-unavailable') {
      return { status: failure }
    }

    throw error
  }
}

export default async function VenueLandingPage({ params }: VenueLandingPageProps) {
  const { venueSlug } = await params
  const lookup = await loadVenue(venueSlug)

  if (lookup.status === 'not-found') {
    notFound()
  }

  if (lookup.status === 'temporarily-unavailable') {
    return <VenueTemporarilyUnavailable />
  }

  return (
    <VenueArrival
      venue={lookup.venue}
      venueSlug={venueSlug}
      media={lookup.media}
      mediaStatus={lookup.mediaStatus}
    />
  )
}
