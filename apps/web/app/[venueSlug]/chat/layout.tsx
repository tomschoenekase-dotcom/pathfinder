import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'

import { db } from '@pathfinder/db'
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

  return <TRPCProvider scopeKey={`venue:${venueSlug}`}>{children}</TRPCProvider>
}
