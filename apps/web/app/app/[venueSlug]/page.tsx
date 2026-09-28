import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { resolveCachedVenueDistribution } from '@pathfinder/db'
import { getChatPalette } from '@pathfinder/ui/theme'
import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { type EmbedSearchParams, resolveAppHeader } from '../../../lib/embed-presentation'
import { parseHostStartParams } from '../../../lib/host-bridge'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import { getPublicVenue } from '../../../lib/public-venue'
import { TRPCProvider } from '../../../lib/trpc'

type AppVenuePageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams: Promise<EmbedSearchParams>
}

export const metadata: Metadata = { robots: { index: false, follow: false } }

export async function generateViewport({
  params,
}: Pick<AppVenuePageProps, 'params'>): Promise<Viewport> {
  const { venueSlug } = await params
  try {
    const venue = await getPublicVenue(venueSlug)
    return { themeColor: getChatPalette(venue.chatTheme, venue.chatAccentColor).bg }
  } catch {
    return { themeColor: '#F2F5F9' }
  }
}

export default async function AppVenuePage({ params, searchParams }: AppVenuePageProps) {
  const { venueSlug } = await params
  const query = await searchParams
  const appHeader = resolveAppHeader(query)
  const start = parseHostStartParams(query)
  const distribution = await resolveCachedVenueDistribution({ venueSlug })
  if (!distribution) notFound()
  if (!distribution.venueActive) return <VenueTemporarilyUnavailable showHomeLink={false} />
  if (!distribution.app.effective) notFound()

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
    <TRPCProvider scopeKey={`app:${venueSlug}`}>
      <VenueChatExperience
        venueSlug={venueSlug}
        initialVenue={{ slug: venueSlug, venue }}
        presentation="webview"
        appHeader={appHeader}
        initialDraft={start.ask ?? ''}
        {...(start.place ? { initialEntryPlaceId: start.place } : {})}
        accessSurface="app"
      />
    </TRPCProvider>
  )
}
