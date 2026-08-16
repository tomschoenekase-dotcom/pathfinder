import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'
import { auth } from '@clerk/nextjs/server'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { appRouter, createTRPCContext } from '@pathfinder/api'
import { VenueTemporarilyUnavailable } from '../../../../../components/VenueTemporarilyUnavailable'
import { classifyPublicVenueLookupError } from '../../../../../lib/public-venue-error'
import { TRPCProvider } from '../../../../../lib/trpc'

type Props = {
  children: ReactNode
  params: Promise<{ venueSlug: string; secondLayerKey: string }>
}

export const dynamic = 'force-dynamic'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f172a',
}

async function getVenue(venueSlug: string, secondLayerKey: string) {
  const requestHeaders = new Headers(await headers())
  const ctx = await createTRPCContext({
    req: new Request('https://pathfinder.local/second-layer', { headers: requestHeaders }),
  })
  return appRouter.createCaller(ctx).venue.getBySlug({ slug: venueSlug, secondLayerKey })
}

export async function generateMetadata({ params }: Omit<Props, 'children'>): Promise<Metadata> {
  const { venueSlug, secondLayerKey } = await params
  try {
    const venue = await getVenue(venueSlug, secondLayerKey)
    return {
      title: `${'experienceLabel' in venue ? venue.experienceLabel : 'Private'} — ${venue.name}`,
      robots: { index: false, follow: false },
      referrer: 'no-referrer',
    }
  } catch {
    return {
      title: 'PathFinder',
      robots: { index: false, follow: false },
      referrer: 'no-referrer',
    }
  }
}

export default async function SecondLayerChatLayout({ children, params }: Props) {
  const { venueSlug, secondLayerKey } = await params
  const returnPath = `/${encodeURIComponent(venueSlug)}/layer/${encodeURIComponent(secondLayerKey)}/chat`
  const authState = await auth()

  if (!authState.userId) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnPath)}`)
  }
  if (!authState.orgId) {
    redirect(`/select-organization?redirect_url=${encodeURIComponent(returnPath)}`)
  }

  try {
    await getVenue(venueSlug, secondLayerKey)
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    if (failure === 'not-found') notFound()
    if (failure === 'temporarily-unavailable') return <VenueTemporarilyUnavailable />
    throw error
  }
  return <TRPCProvider scopeKey={`venue:${venueSlug}:second-layer`}>{children}</TRPCProvider>
}
