import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  client: {
    venue: { getBySlug: { query: vi.fn() } },
    chat: {
      history: { query: vi.fn(async () => ({ messages: [] })) },
      session: { mutate: vi.fn() },
      send: { mutate: vi.fn() },
    },
    analytics: { trackEvent: { mutate: vi.fn() } },
  },
}))

mocks.client.venue.getBySlug.query = mocks.getBySlug

vi.mock('../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))
vi.mock('../hooks/useGeolocation', () => ({
  useGeolocation: () => ({ lat: null, lng: null, permission: 'prompt', refresh: vi.fn() }),
}))
vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ anonymousToken: null, setSessionId: vi.fn() }),
}))
vi.mock('../hooks/useVisitorId', () => ({ useVisitorId: () => null }))
vi.mock('@pathfinder/ui', () => ({
  CHAT_FONT_OPTIONS: [{ value: 'default', cssVar: '--font-sans' }],
  getChatPalette: () => ({
    accent: '#123456',
    accentContrast: '#ffffff',
    bg: '#ffffff',
    card: '#ffffff',
    border: '#dddddd',
    text: '#111111',
    textMuted: '#666666',
  }),
  PathFinderIcon: () => <span>Icon</span>,
}))
vi.mock('./ChatWindow', () => ({
  ChatWindow: ({ emptyState }: { emptyState: React.ReactNode }) => <div>{emptyState}</div>,
}))
vi.mock('./LanguagePicker', () => ({
  getStoredLanguage: () => null,
  LANGUAGE_FALLBACK_DESCRIPTIONS: { English: 'Fallback' },
  LANGUAGE_HEADINGS: { English: 'Ask the guide' },
  LANGUAGE_PLACEHOLDERS: { English: 'Ask' },
  LanguagePicker: () => <div>Language</div>,
  SUPPORTED_LANGUAGES: [{ label: 'English' }],
}))
vi.mock('./LocationBanner', () => ({ LocationBanner: () => null }))
vi.mock('./QuickPromptChips', () => ({ QuickPromptChips: () => null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { VenueChatExperience } from './VenueChatExperience'

const activeVenue = {
  id: 'venue-1',
  name: 'Museum',
  description: null,
  category: null,
  guideMode: 'non_location',
  defaultCenterLat: null,
  defaultCenterLng: null,
  aiGuideName: null,
  chatTheme: null,
  chatAccentColor: null,
  chatFont: null,
  chatLogoUrl: null,
  chatBannerUrl: null,
}

describe('VenueChatExperience presentation boundary', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.stubGlobal('React', React)
  })

  it('keeps embed success chrome inside the embedded experience', async () => {
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    render(<VenueChatExperience venueSlug="museum" presentation="embed" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(screen.queryByText('Back')).toBeNull()
    expect(screen.queryByText('Back to home')).toBeNull()
    expect(screen.getByText('PathFinder').closest('a')).toBeNull()
  })

  it('keeps embed lookup failures free of home navigation', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'NOT_FOUND' })
    render(<VenueChatExperience venueSlug="missing" presentation="embed" />)

    await screen.findByRole('heading', { name: 'Venue unavailable' })
    expect(screen.queryByText('Back to home')).toBeNull()
  })

  it('keeps embed paused state free of home navigation', async () => {
    mocks.getBySlug.mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })
    render(<VenueChatExperience venueSlug="paused" presentation="embed" />)

    await screen.findByRole('heading', { name: 'Guide temporarily unavailable' })
    expect(screen.queryByText('Back to home')).toBeNull()
  })

  it('retains standalone navigation and branding links', async () => {
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    expect(await screen.findByText('Back')).toBeTruthy()
    expect(screen.getByText('Back').closest('a')?.getAttribute('href')).toBe('/museum')
    expect(screen.getByText('PathFinder').closest('a')?.getAttribute('href')).toBe(
      'https://pathfinder.app',
    )
  })
})
