import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { isEmbedPreviewEnabled } from '@pathfinder/config/feature-flags'
import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import { TRPCProvider } from '../../../lib/trpc'

type EmbedVenuePageProps = {
  params: Promise<{ venueSlug: string }>
}

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default async function EmbedVenuePage({ params }: EmbedVenuePageProps) {
  if (!isEmbedPreviewEnabled()) {
    notFound()
  }

  const { venueSlug } = await params
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
      <VenueChatExperience venueSlug={venueSlug} presentation="embed" />
    </TRPCProvider>
  )
}
