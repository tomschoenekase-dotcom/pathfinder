import type { GuestPlaceCard } from '@pathfinder/api'

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
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  places?: GuestPlaceCard[]
}

export type VenueChatPresentation = 'standalone' | 'embed' | 'webview'
