import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { db } from '@pathfinder/db'
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

export async function generateMetadata({ params }: VenueChatMetadataProps): Promise<Metadata> {
  const { venueSlug } = await params

  // $queryRaw is required for this public cross-tenant slug lookup because the
  // visitor only has the venue slug, not the tenant id.
  const [venue] = await db.$queryRaw<{ name: string; description: string | null }[]>`
    SELECT name, description FROM venues WHERE slug = ${venueSlug} AND is_active = true LIMIT 1
  `

  if (!venue) {
    return {
      title: 'PathFinder',
    }
  }

  return {
    title: `${venue.name} — PathFinder`,
    ...(venue.description ? { description: venue.description } : {}),
  }
}

export default async function VenueChatLayout({ children, params }: VenueChatLayoutProps) {
  const { venueSlug } = await params

  const ctx = await createTRPCContext({
    req: new Request(`https://pathfinder.local/${venueSlug}/chat`),
  })

  try {
    await appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug })
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
