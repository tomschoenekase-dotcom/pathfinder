import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { isEmbedPreviewEnabled } from '@pathfinder/config/feature-flags'
import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { WidgetReadySignal } from '../../../components/WidgetReadySignal'
import { resolveEmbedPresentation, type EmbedSearchParams } from '../../../lib/embed-presentation'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import { TRPCProvider } from '../../../lib/trpc'

type EmbedVenuePageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams: Promise<EmbedSearchParams>
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function EmbedVenuePage({ params, searchParams }: EmbedVenuePageProps) {
  if (!isEmbedPreviewEnabled()) {
    notFound()
  }

  const { venueSlug } = await params
  const resolvedSearchParams = await searchParams
  const presentation = resolveEmbedPresentation(resolvedSearchParams)
  const isQuerylessWidget = !Object.values(resolvedSearchParams).some(
    (value) => value !== undefined,
  )
  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/embed/${venueSlug}`),
  })

  try {
    await appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug })
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
      {presentation === 'embed' && isQuerylessWidget ? (
        <WidgetReadySignal venueSlug={venueSlug} />
      ) : null}
      <VenueChatExperience venueSlug={venueSlug} presentation={presentation} />
    </TRPCProvider>
  )
}
