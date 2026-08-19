import type { GuestPlaceCard } from '@pathfinder/api'
import type { PublicVenueBotPresentation } from '@pathfinder/contracts/venue-bot-configuration'

export type VenueSummary = {
  id: string
  name: string
  description: string | null
  category: string | null
  guideMode: string
  defaultCenterLat: number | null
  defaultCenterLng: number | null
  aiGuideName: string | null
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  experienceScope?: 'PUBLIC' | 'SECOND_LAYER'
  experienceLabel?: string | null
  /** Server-resolved, sanitized public presentation. Missing means Classic. */
  venueBotPresentation?: PublicVenueBotPresentation
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  places?: GuestPlaceCard[]
  /** Client-only identity for an optimistic, not-yet-confirmed guest turn. */
  pendingOperationId?: string
}

export type VenueChatPresentation = 'standalone' | 'embed' | 'webview'
