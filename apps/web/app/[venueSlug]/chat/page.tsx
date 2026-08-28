'use client'

import { useParams, useSearchParams } from 'next/navigation'

import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { parseEntryPrompt, parseGuestEntrySource } from '../../../lib/entry-prompt'

export default function VenueChatPage() {
  const { venueSlug } = useParams<{ venueSlug: string }>()
  const searchParams = useSearchParams()
  const entrySource = parseGuestEntrySource(searchParams.get('source'))

  return (
    <VenueChatExperience
      venueSlug={venueSlug}
      presentation="standalone"
      initialDraft={parseEntryPrompt(searchParams.get('prompt'))}
      {...(entrySource ? { entrySource } : {})}
    />
  )
}
