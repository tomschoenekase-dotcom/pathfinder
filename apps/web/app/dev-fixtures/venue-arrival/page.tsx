import type { PublicVenueMediaItem } from '@pathfinder/contracts'
import { notFound } from 'next/navigation'

import { VenueArrival } from '../../../components/VenueArrival'

const FIXTURE_MEDIA: PublicVenueMediaItem[] = [
  ['11111111-1111-4111-8111-111111111111', 768, 512, 'The restored streetcar in the main gallery.'],
  [
    '22222222-2222-4222-8222-222222222222',
    640,
    640,
    'Hands-on navigation instruments in the lake lab.',
  ],
  ['33333333-3333-4333-8333-333333333333', 768, 512, null],
].map(([id, width, height, caption], index) => ({
  assetId: id as string,
  derivativeId: id as string,
  variant: 'CARD' as const,
  kind: 'IMAGE' as const,
  altText: [
    'A restored streetcar beside the museum platform',
    'Navigation instruments arranged in the lake lab',
    'Sunlight across the museum reading room',
  ][index]!,
  caption: caption as string | null,
  importance: index === 0 ? ('PRIMARY' as const) : ('SECONDARY' as const),
  width: width as number,
  height: height as number,
  byteSize: 260_000,
  mimeType: 'image/webp' as const,
  deliveryPath: `/api/venue-media/${id}?venue=great-lakes-museum`,
}))

export default async function VenueArrivalFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const { state = 'media' } = await searchParams
  return (
    <VenueArrival
      venue={{
        name: 'Great Lakes Discovery Museum',
        description: 'Explore lake ecology, shipping history, and hands-on family exhibits.',
        category: 'Museum',
      }}
      venueSlug="great-lakes-museum"
      media={state === 'media' ? FIXTURE_MEDIA : []}
      mediaStatus={state === 'unavailable' ? 'unavailable' : 'ready'}
    />
  )
}
