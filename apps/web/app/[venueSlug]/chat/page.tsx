'use client'

import { useParams } from 'next/navigation'

import { VenueChatExperience } from '../../../components/VenueChatExperience'

export default function VenueChatPage() {
  const { venueSlug } = useParams<{ venueSlug: string }>()

  return <VenueChatExperience venueSlug={venueSlug} presentation="standalone" />
}
