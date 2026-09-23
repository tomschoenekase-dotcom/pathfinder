import { notFound } from 'next/navigation'

import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { getPublicVenue } from '../../../lib/public-venue'
import { classifyPublicVenueLookupError } from '../../../lib/public-venue-error'
import {
  parseEntryPrompt,
  parseGuestEntryPlaceId,
  parseGuestEntrySource,
} from '../../../lib/entry-prompt'

type VenueChatPageProps = {
  params: Promise<{ venueSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function VenueChatPage({ params, searchParams }: VenueChatPageProps) {
  const { venueSlug } = await params
  const query = await searchParams
  const read = (key: string) => {
    const value = query[key]
    return typeof value === 'string' ? value : null
  }
  let venue: Awaited<ReturnType<typeof getPublicVenue>>
  try {
    venue = await getPublicVenue(venueSlug)
  } catch (error) {
    const failure = classifyPublicVenueLookupError(error)
    if (failure === 'not-found') notFound()
    if (failure === 'temporarily-unavailable') return <VenueTemporarilyUnavailable />
    throw error
  }
  const entrySource = parseGuestEntrySource(read('source'))
  const initialEntryPlaceId = parseGuestEntryPlaceId({
    entry: read('entry'),
    source: read('source'),
    item: read('item'),
  })

  return (
    <VenueChatExperience
      venueSlug={venueSlug}
      initialVenue={{ slug: venueSlug, venue }}
      presentation="standalone"
      initialDraft={parseEntryPrompt(read('prompt'))}
      {...(entrySource ? { entrySource } : {})}
      {...(initialEntryPlaceId ? { initialEntryPlaceId } : {})}
    />
  )
}
