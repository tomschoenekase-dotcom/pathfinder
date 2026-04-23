import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'

import { db } from '@pathfinder/db'

type VenueChatLayoutProps = {
  children: ReactNode
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

export default function VenueChatLayout({ children }: VenueChatLayoutProps) {
  return children
}
