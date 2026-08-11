'use client'

import { useParams, useSearchParams } from 'next/navigation'

import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { parseEntryPrompt } from '../../../lib/entry-prompt'

export default function VenueChatPage() {
  const { venueSlug } = useParams<{ venueSlug: string }>()
  const searchParams = useSearchParams()

  return (
    <VenueChatExperience
      venueSlug={venueSlug}
      presentation="standalone"
      initialDraft={parseEntryPrompt(searchParams.get('prompt'))}
    />
  )
}
