'use client'

import { useParams, useSearchParams } from 'next/navigation'

import { VenueChatExperience } from '../../../../../components/VenueChatExperience'
import { parseEntryPrompt } from '../../../../../lib/entry-prompt'

export default function SecondLayerChatPage() {
  const { venueSlug, secondLayerKey } = useParams<{
    venueSlug: string
    secondLayerKey: string
  }>()
  const searchParams = useSearchParams()

  return (
    <VenueChatExperience
      venueSlug={venueSlug}
      secondLayerKey={secondLayerKey}
      presentation="standalone"
      initialDraft={parseEntryPrompt(searchParams.get('prompt'))}
    />
  )
}
