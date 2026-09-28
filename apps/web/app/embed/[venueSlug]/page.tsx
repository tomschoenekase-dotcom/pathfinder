import type { Metadata } from 'next'
import type { Viewport } from 'next'
import { notFound } from 'next/navigation'

import { resolveCachedVenueDistribution } from '@pathfinder/db'
import { getChatPalette } from '@pathfinder/ui/theme'
import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { WidgetReadySignal } from '../../../components/WidgetReadySignal'
import { resolveEmbedPresentation, type EmbedSearchParams } from '../../../lib/embed-presentation'
import { parseHostStartParams } from '../../../lib/host-bridge'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import { getPublicVenue } from '../../../lib/public-venue'
import { TRPCProvider } from '../../../lib/trpc'

type EmbedVenuePageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams: Promise<EmbedSearchParams>
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export async function generateViewport({
  params,
}: Pick<EmbedVenuePageProps, 'params'>): Promise<Viewport> {
  const { venueSlug } = await params
  try {
    const venue = await getPublicVenue(venueSlug)
    return { themeColor: getChatPalette(venue.chatTheme, venue.chatAccentColor).bg }
  } catch {
    return { themeColor: '#F2F5F9' }
  }
}

export default async function EmbedVenuePage({ params, searchParams }: EmbedVenuePageProps) {
  const { venueSlug } = await params
  const resolvedSearchParams = await searchParams
  const presentation = resolveEmbedPresentation(resolvedSearchParams)
  const start = parseHostStartParams(resolvedSearchParams)
  const distribution = await resolveCachedVenueDistribution({ venueSlug })
  if (!distribution) notFound()
  if (!distribution.venueActive) return <VenueTemporarilyUnavailable showHomeLink={false} />
  const appAlias = presentation === 'webview'
  if (appAlias ? !distribution.app.effective : !distribution.website.effective) notFound()

  let venue: Awaited<ReturnType<typeof getPublicVenue>>
  try {
    venue = await getPublicVenue(venueSlug)
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)

    if (failure === 'not-found') {
      notFound()
    }

    if (failure === 'temporarily-unavailable') {
      return <VenueTemporarilyUnavailable showHomeLink={false} />
    }

    throw error
  }

  return (
    <TRPCProvider scopeKey={`embed:${venueSlug}`}>
      {presentation !== 'webview' ? <WidgetReadySignal venueSlug={venueSlug} /> : null}
      <VenueChatExperience
        venueSlug={venueSlug}
        initialVenue={{ slug: venueSlug, venue }}
        presentation={presentation}
        initialDraft={start.ask ?? ''}
        {...(start.place ? { initialEntryPlaceId: start.place } : {})}
        {...(!appAlias ? { bridgeOrigins: distribution.website.origins } : {})}
        accessSurface={appAlias ? 'app' : 'website'}
      />
    </TRPCProvider>
  )
}
