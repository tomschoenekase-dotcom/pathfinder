import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { resolveCachedVenueDistribution } from '@pathfinder/db'
import { getChatPalette } from '@pathfinder/ui/theme'
import { VenueChatExperience } from '../../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../../components/VenueTemporarilyUnavailable'
import { WidgetReadySignal } from '../../../../components/WidgetReadySignal'
import { parseHostStartParams } from '../../../../lib/host-bridge'
import { classifyPublicVenueLookupError } from '../../../../lib/public-venue-error'
import { getPublicVenue } from '../../../../lib/public-venue'
import { TRPCProvider } from '../../../../lib/trpc'

type InlineVenuePageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export const metadata: Metadata = { robots: { index: false, follow: false } }

export async function generateViewport({ params }: InlineVenuePageProps): Promise<Viewport> {
  const { venueSlug } = await params
  try {
    const venue = await getPublicVenue(venueSlug)
    return { themeColor: getChatPalette(venue.chatTheme, venue.chatAccentColor).bg }
  } catch {
    return { themeColor: '#F2F5F9' }
  }
}

export default async function InlineVenuePage({ params, searchParams }: InlineVenuePageProps) {
  const { venueSlug } = await params
  const start = parseHostStartParams((await searchParams) ?? {})
  const distribution = await resolveCachedVenueDistribution({ venueSlug })
  if (!distribution) notFound()
  if (!distribution.venueActive) return <VenueTemporarilyUnavailable showHomeLink={false} />
  if (!distribution.website.effective) notFound()

  let venue: Awaited<ReturnType<typeof getPublicVenue>>
  try {
    venue = await getPublicVenue(venueSlug)
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    if (failure === 'not-found') notFound()
    if (failure === 'temporarily-unavailable')
      return <VenueTemporarilyUnavailable showHomeLink={false} />
    throw error
  }

  return (
    <TRPCProvider scopeKey={`embed-inline:${venueSlug}`}>
      <WidgetReadySignal venueSlug={venueSlug} />
      <VenueChatExperience
        venueSlug={venueSlug}
        initialVenue={{ slug: venueSlug, venue }}
        presentation="embed-inline"
        initialDraft={start.ask ?? ''}
        {...(start.place ? { initialEntryPlaceId: start.place } : {})}
        bridgeOrigins={distribution.website.origins}
        accessSurface="website"
      />
    </TRPCProvider>
  )
}
