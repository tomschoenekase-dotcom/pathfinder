import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  anonymousToken: null as string | null,
  identityUnavailable: false,
  sessionTokens: {} as Record<string, string>,
  startNewConversation: vi.fn(),
  setSessionId: vi.fn(),
  geolocation: { lat: null as number | null, lng: null as number | null },
  geolocationPermission: 'granted' as 'granted' | 'denied' | 'prompt' | 'loading',
  geolocationEnabled: vi.fn(),
  client: {
    venue: { getBySlug: { query: vi.fn() } },
    chat: {
      history: {
        query: vi.fn(async () => ({
          messages: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
        })),
      },
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
      permission: mocks.geolocationPermission,
      refresh: vi.fn(),
    }
  },
}))
vi.mock('../hooks/useSession', () => ({
  useSession: (venueId: string) => ({
    anonymousToken: mocks.sessionTokens[venueId] ?? mocks.anonymousToken,
    identityUnavailable: mocks.identityUnavailable,
    setSessionId: mocks.setSessionId,
    startNewConversation: mocks.startNewConversation,
  }),
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
    errorMessage,
    messages,
    onSend,
  }: {
    emptyState: React.ReactNode
    errorMessage?: string | null
    messages: unknown[]
    onSend: (message: string) => void
  }) => (
    <div>
      {emptyState}
      {errorMessage ? <span>{errorMessage}</span> : null}
      <span>Messages: {messages.length}</span>
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
    window.sessionStorage.clear()
    mocks.anonymousToken = null
    mocks.identityUnavailable = false
    mocks.sessionTokens = {}
    mocks.startNewConversation.mockReturnValue(true)
    mocks.geolocation.lat = null
    mocks.geolocation.lng = null
    mocks.geolocationPermission = 'granted'
    mocks.client.chat.session.mutate.mockResolvedValue({ sessionId: 'session-1' })
    mocks.client.chat.send.mutate.mockResolvedValue({
      response: 'Nearby.',
      sessionId: 'session-1',
      places: [],
    })
    mocks.client.analytics.trackEvent.mutate.mockResolvedValue({ ok: true })
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it.each(['standalone', 'embed'] as const)(
    'keeps AI accuracy and sensitive-information guidance visible in %s presentation',
    async (presentation) => {
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)
      render(<VenueChatExperience venueSlug="museum" presentation={presentation} />)

      await screen.findByRole('heading', { name: 'Museum Guide' })
      expect(screen.getByRole('note', { name: 'AI guidance' }).textContent).toContain(
        'AI-generated answers can be wrong',
      )
      expect(screen.getByRole('note', { name: 'AI guidance' }).textContent).toContain(
        'do not share sensitive information',
      )
    },
  )

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

  it('allows location-aware knowledge chat without coordinates or a default center', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174020'
    mocks.geolocationPermission = 'denied'
    mocks.getBySlug.mockResolvedValueOnce({ ...activeVenue, guideMode: 'location_aware' })

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the café?',
    })
    expect(screen.queryByText(/Location is still unavailable/)).toBeNull()
  })

  it('does not send a venue default center as the visitor position', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174021'
    mocks.getBySlug.mockResolvedValueOnce({
      ...activeVenue,
      guideMode: 'location_aware',
      defaultCenterLat: 38.627,
      defaultCenterLng: -90.1994,
    })

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the café?',
    })
  })

  it('sends a complete live position for distance-aware chat', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174022'
    mocks.geolocation.lat = 38.63
    mocks.geolocation.lng = -90.2
    mocks.getBySlug.mockResolvedValueOnce({ ...activeVenue, guideMode: 'location_aware' })

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the café?',
      lat: 38.63,
      lng: -90.2,
    })
  })

  it('syncs only coordinate pairs and resyncs the same position after access returns', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174023'
    mocks.geolocation.lat = 38.63
    mocks.geolocation.lng = null
    mocks.getBySlug.mockResolvedValueOnce({ ...activeVenue, guideMode: 'location_aware' })

    const view = render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.session.mutate).toHaveBeenLastCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
    })

    mocks.geolocation.lng = -90.2
    view.rerender(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.client.chat.session.mutate).toHaveBeenLastCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      lat: 38.63,
      lng: -90.2,
    })

    mocks.geolocation.lat = null
    mocks.geolocation.lng = null
    view.rerender(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledTimes(3))

    mocks.geolocation.lat = 38.63
    mocks.geolocation.lng = -90.2
    view.rerender(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledTimes(4))
    expect(mocks.client.chat.session.mutate).toHaveBeenLastCalledWith({
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      lat: 38.63,
      lng: -90.2,
    })
  })

  it('starts a new conversation, clears visible history, and ends the prior analytics session', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174001'
    const nextToken = '123e4567-e89b-42d3-a456-426614174011'
    mocks.anonymousToken = token
    mocks.startNewConversation.mockImplementationOnce(() => {
      mocks.anonymousToken = nextToken
      return true
    })
    window.sessionStorage.setItem(`pathfinder_session_${activeVenue.id}`, token)
    mocks.client.chat.history.query.mockResolvedValueOnce({
      messages: [{ role: 'assistant', content: 'Welcome back.' }],
    })
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByText('Messages: 1')
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(mocks.startNewConversation).toHaveBeenCalledOnce()
    expect(screen.getByText('Messages: 0')).toBeTruthy()
    expect(mocks.client.analytics.trackEvent.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: activeVenue.id,
        sessionId: token,
        eventType: 'session.ended',
      }),
    )
    await waitFor(() =>
      expect(mocks.client.chat.session.mutate).toHaveBeenCalledWith({
        venueId: activeVenue.id,
        anonymousToken: nextToken,
      }),
    )
    expect(mocks.client.analytics.trackEvent.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: activeVenue.id,
        sessionId: nextToken,
        eventType: 'session.started',
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() =>
      expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ anonymousToken: nextToken }),
      ),
    )
  })

  it('disables New conversation while a message is in flight', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174002'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate.mockReturnValueOnce(new Promise(() => {}))

    render(<VenueChatExperience venueSlug="museum" presentation="embed" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement).disabled,
      ).toBe(true)
    })
    expect(mocks.startNewConversation).not.toHaveBeenCalled()
  })

  it('preserves the current chat when New conversation confirmation is cancelled', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174012'
    mocks.anonymousToken = token
    window.sessionStorage.setItem(`pathfinder_session_${activeVenue.id}`, token)
    mocks.client.chat.history.query.mockResolvedValueOnce({
      messages: [{ role: 'assistant', content: 'Keep this chat.' }],
    })
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await screen.findByText('Messages: 1')

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(mocks.startNewConversation).not.toHaveBeenCalled()
    expect(screen.getByText('Messages: 1')).toBeTruthy()
  })

  it('preserves the current chat and reports a controlled reset failure', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174013'
    mocks.anonymousToken = token
    mocks.startNewConversation.mockReturnValueOnce(false)
    window.sessionStorage.setItem(`pathfinder_session_${activeVenue.id}`, token)
    mocks.client.chat.history.query.mockResolvedValueOnce({
      messages: [{ role: 'assistant', content: 'Keep this chat.' }],
    })
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await screen.findByText('Messages: 1')

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(screen.getByText('Messages: 1')).toBeTruthy()
    expect(screen.getByText('We could not start a new conversation in this browser.')).toBeTruthy()
  })

  it('clears old messages on venue transitions and ignores a late prior response', async () => {
    let resolveOldSend!: (value: { response: string; sessionId: string; places: never[] }) => void
    const oldSend = new Promise<{ response: string; sessionId: string; places: never[] }>(
      (resolve) => {
        resolveOldSend = resolve
      },
    )
    let resolveOldSession!: (value: { sessionId: string }) => void
    const oldSession = new Promise<{ sessionId: string }>((resolve) => {
      resolveOldSession = resolve
    })
    const secondVenue = { ...activeVenue, id: 'venue-2', name: 'Aquarium' }
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174003'
    mocks.sessionTokens['venue-2'] = mocks.anonymousToken
    window.sessionStorage.setItem(`pathfinder_session_${activeVenue.id}`, mocks.anonymousToken)
    mocks.client.chat.history.query.mockResolvedValueOnce({
      messages: [{ role: 'assistant', content: 'Museum history.' }],
    })
    mocks.getBySlug.mockResolvedValueOnce(activeVenue).mockResolvedValueOnce(secondVenue)
    mocks.client.chat.send.mutate.mockReturnValueOnce(oldSend)
    mocks.client.chat.session.mutate.mockReturnValueOnce(oldSession)

    const view = render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await screen.findByText('Messages: 1')
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await screen.findByText('Messages: 2')

    view.rerender(<VenueChatExperience venueSlug="aquarium" presentation="standalone" />)
    await screen.findByRole('heading', { name: 'Aquarium Guide' })
    expect(screen.getByText('Messages: 0')).toBeTruthy()

    resolveOldSend({ response: 'Late museum answer.', sessionId: 'session-old', places: [] })
    resolveOldSession({ sessionId: 'session-old' })
    await waitFor(() => expect(screen.getByText('Messages: 0')).toBeTruthy())
    expect(mocks.setSessionId).not.toHaveBeenCalledWith('session-old')
  })

  it('keeps the venue usable when sessionStorage cannot be read', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174005'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(mocks.client.chat.history.query).not.toHaveBeenCalled()
  })

  it('shows a controlled degraded state when no private session identity can be created', async () => {
    mocks.identityUnavailable = true
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(
      await screen.findByText('This browser cannot create a private chat session.'),
    ).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('does not apply late history from a previous venue load', async () => {
    let resolveOldHistory!: (value: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
    }) => void
    const oldHistory = new Promise<{
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
    }>((resolve) => {
      resolveOldHistory = resolve
    })
    const token = '123e4567-e89b-42d3-a456-426614174006'
    const secondVenue = { ...activeVenue, id: 'venue-2', name: 'Aquarium' }
    mocks.anonymousToken = token
    mocks.sessionTokens['venue-2'] = token
    window.sessionStorage.setItem(`pathfinder_session_${activeVenue.id}`, token)
    mocks.getBySlug.mockResolvedValueOnce(activeVenue).mockResolvedValueOnce(secondVenue)
    mocks.client.chat.history.query.mockReturnValueOnce(oldHistory)

    const view = render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)
    await waitFor(() => expect(mocks.client.chat.history.query).toHaveBeenCalledOnce())

    view.rerender(<VenueChatExperience venueSlug="aquarium" presentation="standalone" />)
    await screen.findByRole('heading', { name: 'Aquarium Guide' })

    resolveOldHistory({ messages: [{ role: 'assistant', content: 'Late museum history.' }] })
    await waitFor(() => expect(screen.getByText('Messages: 0')).toBeTruthy())
  })
})
