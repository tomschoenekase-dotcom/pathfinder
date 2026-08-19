import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import { TRPCProvider } from '../../../lib/trpc'

type VenueChatLayoutProps = {
  children: ReactNode
  params: Promise<{
    venueSlug: string
  }>
}

type VenueChatMetadataProps = {
  params: Promise<{
    venueSlug: string
  }>
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f172a',
}

async function getPublicVenue(venueSlug: string) {
  const ctx = await createTRPCContext({
    req: new Request('https://pathfinder.local/public-venue'),
  })

  return appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug })
}

export async function generateMetadata({ params }: VenueChatMetadataProps): Promise<Metadata> {
  const { venueSlug } = await params

  try {
    const venue = await getPublicVenue(venueSlug)
    return {
      title: `${venue.name} — Torchiko`,
      ...(venue.description ? { description: venue.description } : {}),
    }
  } catch {
    return {
      title: 'Torchiko',
    }
  }
}

export default async function VenueChatLayout({ children, params }: VenueChatLayoutProps) {
  const { venueSlug } = await params

  try {
    await getPublicVenue(venueSlug)
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)

    if (failure === 'not-found') {
      notFound()
    }

    if (failure === 'temporarily-unavailable') {
      return <VenueTemporarilyUnavailable />
    }

    throw error
  }

  return <TRPCProvider scopeKey={`venue:${venueSlug}`}>{children}</TRPCProvider>
}
