import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  anonymousToken: null as string | null,
  geolocation: { lat: null as number | null, lng: null as number | null },
  geolocationEnabled: vi.fn(),
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
  useGeolocation: (enabled: boolean) => {
    mocks.geolocationEnabled(enabled)
    return {
      ...mocks.geolocation,
      permission: 'granted',
      refresh: vi.fn(),
    }
  },
}))
vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ anonymousToken: mocks.anonymousToken, setSessionId: vi.fn() }),
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
  ChatWindow: ({
    emptyState,
    onSend,
  }: {
    emptyState: React.ReactNode
    onSend: (message: string) => void
  }) => (
    <div>
      {emptyState}
      <button onClick={() => onSend('Where is the café?')}>Send test message</button>
    </div>
  ),
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
    mocks.anonymousToken = null
    mocks.geolocation.lat = null
    mocks.geolocation.lng = null
    mocks.client.chat.session.mutate.mockResolvedValue({ sessionId: 'session-1' })
    mocks.client.chat.send.mutate.mockResolvedValue({
      response: 'Nearby.',
      sessionId: 'session-1',
      places: [],
    })
    mocks.client.analytics.trackEvent.mutate.mockResolvedValue({ ok: true })
    vi.stubGlobal('React', React)
  })

  it('keeps embed success chrome inside the embedded experience', async () => {
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    render(<VenueChatExperience venueSlug="museum" presentation="embed" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(mocks.geolocationEnabled).not.toHaveBeenCalledWith(true)
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

  it('omits granted live coordinates from non-location session and send requests', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174000'
    mocks.geolocation.lat = 40.7128
    mocks.geolocation.lng = -74.006
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.session.mutate).toHaveBeenCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the café?',
    })
  })
})
