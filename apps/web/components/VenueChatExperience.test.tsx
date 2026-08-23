import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  anonymousToken: null as string | null,
  sessionId: null as string | null,
  identityUnavailable: false,
  sessionTokens: {} as Record<string, string>,
  startNewConversation: vi.fn(),
  setSessionId: vi.fn(),
  geolocation: { lat: null as number | null, lng: null as number | null },
  geolocationPermission: 'granted' as 'granted' | 'denied' | 'prompt' | 'loading',
  geolocationEnabled: vi.fn(),
  connectionState: 'online' as 'online' | 'offline' | 'reconnected',
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
vi.mock('../hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mocks.connectionState,
}))
vi.mock('../hooks/useSession', () => ({
  useSession: (venueId: string) => ({
    anonymousToken: mocks.sessionTokens[venueId] ?? mocks.anonymousToken,
    sessionId: mocks.sessionId,
    identityUnavailable: mocks.identityUnavailable,
    setSessionId: mocks.setSessionId,
    startNewConversation: mocks.startNewConversation,
  }),
}))
vi.mock('../hooks/useVisitorId', () => ({ useVisitorId: () => null }))
vi.mock('@pathfinder/ui/theme', () => ({
  CHAT_FONT_OPTIONS: [{ value: 'default', cssVar: '--font-sans' }],
  getChatPalette: () => ({
    accent: '#123456',
    accentText: '#123456',
    accentContrast: '#ffffff',
    bg: '#ffffff',
    card: '#ffffff',
    border: '#dddddd',
    text: '#111111',
    textMuted: '#666666',
  }),
}))
vi.mock('@pathfinder/ui/brand', () => ({ TorchikoIcon: () => <span>Icon</span> }))
vi.mock('@pathfinder/ui/character', () => ({
  PublicCharacterPresence: ({ state }: { state: string }) => <span>Character visual: {state}</span>,
}))
vi.mock('./VoiceControl', () => ({ VoiceControl: () => null }))
vi.mock('./ChatWindow', () => ({
  ChatWindow: ({
    emptyState,
    errorMessage,
    messages,
    onSend,
    onDraftChange,
    onRetry,
    retryLabel,
    onPlaceCardClick,
    onPlaceCardView,
  }: {
    emptyState: React.ReactNode
    errorMessage?: string | null
    messages: Array<{ places?: Array<{ id: string }> }>
    onSend: (message: string) => void
    onDraftChange?: (draft: string) => void
    onRetry?: () => void
    retryLabel?: string
    onPlaceCardClick?: (placeId: string) => void
    onPlaceCardView?: (placeId: string) => void
  }) => (
    <div>
      {emptyState}
      {errorMessage ? <span>{errorMessage}</span> : null}
      <span>Messages: {messages.length}</span>
      <span>Cards: {messages.flatMap((message) => message.places ?? []).length}</span>
      {messages
        .flatMap((message) => message.places ?? [])
        .map((place) => (
          <div key={place.id}>
            <button onClick={() => onPlaceCardView?.(place.id)}>View {place.id}</button>
            <button onClick={() => onPlaceCardClick?.(place.id)}>Open {place.id}</button>
          </div>
        ))}
      <button onClick={() => onSend('Where is the café?')}>Send test message</button>
      <button onClick={() => onSend('Where is parking?')}>Send different message</button>
      <button onClick={() => onDraftChange?.('Edited draft')}>Edit draft</button>
      {onRetry ? <button onClick={onRetry}>{retryLabel ?? 'Retry same message'}</button> : null}
    </div>
  ),
}))
vi.mock('./LanguagePicker', () => ({
  getStoredLanguage: () => null,
  getChatLanguagePresentation: (language: string) =>
    language === '\u0627\u0644\u0639\u0631\u0628\u064a\u0629'
      ? { code: 'ar', direction: 'rtl' }
      : { code: 'en', direction: 'ltr' },
  LANGUAGE_FALLBACK_DESCRIPTIONS: { English: 'Fallback' },
  LANGUAGE_HEADINGS: { English: 'Ask the guide' },
  LANGUAGE_PLACEHOLDERS: { English: 'Ask' },
  LanguagePicker: ({ onChange }: { onChange: (language: string) => void }) => (
    <>
      <button type="button" onClick={() => onChange('\u0627\u0644\u0639\u0631\u0628\u064a\u0629')}>
        Choose Arabic
      </button>
      <button type="button" onClick={() => onChange('English')}>
        Choose English
      </button>
    </>
  ),
  SUPPORTED_LANGUAGES: [
    { label: 'English' },
    { label: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629' },
  ],
}))
vi.mock('./LocationBanner', () => ({ LocationBanner: () => null }))
vi.mock('./LocationRoutePlanner', () => ({
  LocationRoutePlanner: ({
    venueId,
    anonymousToken,
  }: {
    venueId: string
    anonymousToken: string | null
  }) => (
    <div>
      Route planner for {venueId}: {anonymousToken ?? 'waiting for session'}
    </div>
  ),
}))
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

const characterVenue = {
  ...activeVenue,
  venueBotPresentation: {
    mode: 'CHARACTER' as const,
    displayName: 'Museum Tochi',
    greeting: 'Ask me anything about your visit.',
    personalityPreset: 'friendly' as const,
    character: {
      characterId: 'tochi',
      displayName: 'Tochi',
      assetPackId: 'tochi-approved',
      assetPackVersion: '1.0.0',
      renderer: 'static-image-v1' as const,
      publicBasePath: '/characters/tochi/1.0.0',
      assets: [
        {
          id: 'fallback',
          path: 'fallback.svg',
          mediaType: 'image/svg+xml' as const,
          width: 128,
          height: 128,
          bytes: 512,
        },
      ],
      canvas: { width: 128, height: 128 },
      anchors: { lookAt: { x: 64, y: 52 }, embers: { x: 64, y: 18 } },
      staticFallbackAssetId: 'fallback',
      reducedMotionFallbackAssetId: 'fallback',
      layers: {},
      states: {},
      stateFallbacks: {},
      supportedContexts: ['venue-text-chat' as const],
    },
  },
}

function codedError(code: string, publicCode?: string) {
  return Object.assign(new Error(code), { data: { code, ...(publicCode ? { publicCode } : {}) } })
}

describe('VenueChatExperience presentation boundary', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    window.sessionStorage.clear()
    mocks.anonymousToken = null
    mocks.sessionId = null
    mocks.identityUnavailable = false
    mocks.sessionTokens = {}
    mocks.startNewConversation.mockReturnValue(true)
    mocks.geolocation.lat = null
    mocks.geolocation.lng = null
    mocks.geolocationPermission = 'granted'
    mocks.connectionState = 'online'
    mocks.client.chat.session.mutate.mockResolvedValue({ sessionId: 'session-1' })
    mocks.client.chat.send.mutate.mockResolvedValue({
      response: 'Nearby.',
      sessionId: 'session-1',
      places: [],
      replayed: false,
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
    expect(screen.getByText('Torchiko').closest('a')).toBeNull()
  })

  it('does not admit route catalog reads until the public session is confirmed', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174099'
    mocks.getBySlug.mockResolvedValue(activeVenue)
    const view = render(<VenueChatExperience venueSlug="museum" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(screen.getByText(/Route planner for venue-1: waiting for session/)).toBeTruthy()

    mocks.sessionId = 'session-1'
    view.rerender(<VenueChatExperience venueSlug="museum" />)
    expect(screen.getByText(`Route planner for venue-1: ${mocks.anonymousToken}`)).toBeTruthy()
  })

  it('blocks network mutations offline and prepares the session after reconnection', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174199'
    mocks.connectionState = 'offline'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    const view = render(<VenueChatExperience venueSlug="museum" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    expect(mocks.client.chat.send.mutate).not.toHaveBeenCalled()
    expect(mocks.client.chat.session.mutate).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'New conversation' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    mocks.connectionState = 'reconnected'
    view.rerender(<VenueChatExperience venueSlug="museum" />)
    await waitFor(() => expect(mocks.client.chat.session.mutate).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledOnce())
  })

  it('creates one UUID operation and fences same-tick duplicate submission', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174100'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate.mockReturnValueOnce(new Promise(() => {}))
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    const send = screen.getByRole('button', { name: 'Send test message' })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledOnce()
    const input = mocks.client.chat.send.mutate.mock.calls[0]?.[0]
    expect(input.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(screen.getByText('Messages: 1')).toBeTruthy()
  })

  it('retries an ambiguous turn with the exact frozen input and no duplicate optimistic message', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174101'
    mocks.geolocation.lat = 38.63
    mocks.geolocation.lng = -90.2
    mocks.getBySlug.mockResolvedValueOnce({ ...activeVenue, guideMode: 'location_aware' })
    mocks.client.chat.send.mutate
      .mockRejectedValueOnce(codedError('SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce({
        response: 'The café is downstairs.',
        sessionId: 'session-1',
        places: [],
        replayed: true,
      })
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Arabic' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    const retry = await screen.findByRole('button', { name: 'Retry same message' })
    const frozen = mocks.client.chat.send.mutate.mock.calls[0]?.[0]
    expect(screen.getByText('Messages: 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose English' }))
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.client.chat.send.mutate.mock.calls[1]?.[0]).toEqual(frozen)
    expect(await screen.findByText('Messages: 2')).toBeTruthy()
  })

  it('rotates operation identity when the guest edits after an ambiguous outcome', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174102'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate
      .mockRejectedValueOnce(codedError('SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce({
        response: 'Parking is east of the entrance.',
        sessionId: 'session-1',
        places: [],
        replayed: false,
      })
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await screen.findByRole('button', { name: 'Retry same message' })
    const firstId = mocks.client.chat.send.mutate.mock.calls[0]?.[0].operationId
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
    expect(screen.queryByRole('button', { name: 'Retry same message' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.client.chat.send.mutate.mock.calls[1]?.[0].operationId).not.toBe(firstId)
  })

  it('removes only the abandoned optimistic bubble and preserves committed same-text turns', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174107'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate
      .mockResolvedValueOnce({
        response: 'First committed answer.',
        sessionId: 'session-1',
        places: [],
        replayed: false,
      })
      .mockRejectedValueOnce(codedError('SERVICE_UNAVAILABLE'))
      .mockResolvedValueOnce({
        response: 'Parking answer.',
        sessionId: 'session-1',
        places: [],
        replayed: false,
      })
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    expect(await screen.findByText('Messages: 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await screen.findByRole('button', { name: 'Retry same message' })
    expect(screen.getByText('Messages: 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
    expect(screen.getByText('Messages: 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    expect(await screen.findByText('Messages: 4')).toBeTruthy()
  })

  it('rotates operation identity after each confirmed successful turn', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174104'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    const firstId = mocks.client.chat.send.mutate.mock.calls[0]?.[0].operationId
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.client.chat.send.mutate.mock.calls[1]?.[0].operationId).not.toBe(firstId)
    expect(await screen.findByText('Messages: 4')).toBeTruthy()
  })

  it.each(['CONFLICT', 'PRECONDITION_FAILED'])(
    'reconciles history after %s and does not offer ambiguous retry',
    async (code) => {
      mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174103'
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)
      mocks.client.chat.send.mutate.mockRejectedValueOnce(codedError(code))
      mocks.client.chat.history.query.mockResolvedValueOnce({
        messages: [
          { role: 'user', content: 'Where is the café?' },
          { role: 'assistant', content: 'The café is downstairs.' },
        ],
      })
      render(<VenueChatExperience venueSlug="museum" />)
      await screen.findByRole('heading', { name: 'Museum Guide' })
      fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
      expect(await screen.findByText('Messages: 2')).toBeTruthy()
      expect(mocks.client.chat.history.query).toHaveBeenCalledWith({
        venueId: activeVenue.id,
        anonymousToken: mocks.anonymousToken,
      })
      expect(screen.queryByRole('button', { name: 'Retry same message' })).toBeNull()
    },
  )

  it('settles a terminal ambiguous operation from history and permits only a new operation', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174108'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate.mockRejectedValueOnce(codedError('PRECONDITION_FAILED'))
    mocks.client.chat.history.query.mockResolvedValueOnce({ messages: [] })
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    expect(await screen.findByText(/will not be retried/i)).toBeTruthy()
    expect(screen.getByText('Messages: 0')).toBeTruthy()
    const terminalId = mocks.client.chat.send.mutate.mock.calls[0]?.[0].operationId
    expect(screen.queryByRole('button', { name: 'Retry same message' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.client.chat.send.mutate.mock.calls[1]?.[0].operationId).not.toBe(terminalId)
  })

  it('blocks new turns until a failed conflict reconciliation succeeds', async () => {
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174106'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    mocks.client.chat.send.mutate.mockRejectedValueOnce(codedError('CONFLICT'))
    mocks.client.chat.history.query
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce({ messages: [{ role: 'assistant', content: 'Current history.' }] })
    render(<VenueChatExperience venueSlug="museum" />)
    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    const check = await screen.findByRole('button', { name: 'Check conversation' })
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledOnce()
    fireEvent.click(check)
    expect(await screen.findByText('Messages: 1')).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Check conversation' })).toBeNull(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(2))
  })

  it.each(['BAD_REQUEST', 'NOT_FOUND'])(
    'treats %s as definite and requires a deliberate new turn',
    async (code) => {
      mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174105'
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)
      mocks.client.chat.send.mutate.mockRejectedValueOnce(codedError(code))
      render(<VenueChatExperience venueSlug="museum" />)
      await screen.findByRole('heading', { name: 'Museum Guide' })
      fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
      expect(await screen.findByText(/could not be accepted/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Retry same message' })).toBeNull()
      expect(mocks.client.chat.history.query).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['PROVIDER_UNAVAILABLE', /guide service is temporarily unavailable/i],
    ['CONTENT_UNAVAILABLE', /venue content is not available/i],
    ['TRANSIENT_FAILURE', /could not start this message/i],
  ])(
    'shows definite recovery guidance for %s without unsafe same-operation retry',
    async (publicCode, message) => {
      mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174105'
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)
      mocks.client.chat.send.mutate.mockRejectedValueOnce(
        codedError('SERVICE_UNAVAILABLE', publicCode),
      )
      render(<VenueChatExperience venueSlug="museum" />)
      await screen.findByRole('heading', { name: 'Museum Guide' })
      fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
      expect(await screen.findByText(message)).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Retry same message' })).toBeNull()
    },
  )

  it('suppresses the Torchiko footer in native web-view presentation', async () => {
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    render(<VenueChatExperience venueSlug="museum" presentation="webview" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    expect(screen.queryByText(/Powered by/)).toBeNull()
    expect(screen.queryByText('Back')).toBeNull()
    expect(screen.getByRole('note', { name: 'AI guidance' })).toBeTruthy()
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

    const backLink = (await screen.findByText('Back')).closest('a')
    const brandLink = screen.getByText('Torchiko').closest('a')
    expect(backLink?.getAttribute('href')).toBe('/museum')
    expect(backLink?.className).toContain('min-h-11')
    expect(brandLink?.getAttribute('href')).toBe('https://torchiko.com')
    expect(brandLink?.className).toContain('min-h-11')
    expect(brandLink?.className).toContain('min-w-11')
    expect(screen.getByRole('button', { name: 'New conversation' }).className).toContain('min-h-11')
  })

  it.each(['standalone', 'embed', 'webview'] as const)(
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
      operationId: expect.any(String),
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the café?',
    })
  })

  it.each(['standalone', 'embed', 'webview'] as const)(
    'sends the Arabic response preference across the %s presentation',
    async (presentation) => {
      mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174010'
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)

      render(<VenueChatExperience venueSlug="museum" presentation={presentation} />)

      await screen.findByRole('heading', { name: 'Museum Guide' })
      fireEvent.click(screen.getByRole('button', { name: 'Choose Arabic' }))
      const localizedEmptyState = screen.getByText('Ask the guide').closest('[lang="ar"]')
      expect(localizedEmptyState?.getAttribute('dir')).toBe('rtl')
      fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

      await waitFor(() =>
        expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
          operationId: expect.any(String),
          venueId: activeVenue.id,
          anonymousToken: mocks.anonymousToken,
          message: 'Where is the caf\u00e9?',
          language: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629',
        }),
      )
    },
  )

  it('keeps the dispatched response preference stable when selection changes mid-flight', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174011'
    mocks.getBySlug.mockResolvedValueOnce(activeVenue)
    let resolveSend!: (value: { response: string; sessionId: string; places: never[] }) => void
    mocks.client.chat.send.mutate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve
      }),
    )

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Arabic' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Choose English' }))

    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      venueId: activeVenue.id,
      anonymousToken: mocks.anonymousToken,
      message: 'Where is the caf\u00e9?',
      language: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629',
    })

    resolveSend({ response: 'English fallback.', sessionId: 'session-1', places: [] })
    expect(await screen.findByText('Messages: 2')).toBeTruthy()
  })

  it.each(['standalone', 'embed', 'webview'] as const)(
    'keeps returned no-location cards in the %s presentation and tracks real actions',
    async (presentation) => {
      const token = '123e4567-e89b-12d3-a456-426614174000'
      mocks.anonymousToken = token
      mocks.getBySlug.mockResolvedValueOnce(activeVenue)
      mocks.client.chat.send.mutate.mockResolvedValueOnce({
        response: 'Visit the East Gallery.',
        sessionId: 'session-1',
        places: [
          {
            id: 'place-1',
            name: 'East Gallery',
            type: 'EXHIBIT',
            photoUrl: null,
            shortDescription: 'Textile collection.',
            areaName: 'Second floor',
            hours: '10:00 AM–4:00 PM',
            distanceMeters: undefined,
            lat: null,
            lng: null,
          },
        ],
      })

      render(<VenueChatExperience venueSlug="museum" presentation={presentation} />)

      await screen.findByRole('heading', { name: 'Museum Guide' })
      fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
      await screen.findByText('Cards: 1')
      fireEvent.click(screen.getByRole('button', { name: 'View place-1' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open place-1' }))

      expect(mocks.client.analytics.trackEvent.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: activeVenue.id,
          sessionId: token,
          eventType: 'place_card.viewed',
          placeId: 'place-1',
        }),
      )
      expect(mocks.client.analytics.trackEvent.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: activeVenue.id,
          sessionId: token,
          eventType: 'place_card.clicked',
          placeId: 'place-1',
        }),
      )
    },
  )

  it('allows location-aware knowledge chat without coordinates or a default center', async () => {
    mocks.anonymousToken = '123e4567-e89b-12d3-a456-426614174020'
    mocks.geolocationPermission = 'denied'
    mocks.getBySlug.mockResolvedValueOnce({ ...activeVenue, guideMode: 'location_aware' })

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    await screen.findByRole('heading', { name: 'Museum Guide' })
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))

    await waitFor(() => expect(mocks.client.chat.send.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.client.chat.send.mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
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
      operationId: expect.any(String),
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
      operationId: expect.any(String),
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

  it('maps real text-chat lifecycle events to truthful character states', async () => {
    let resolveSend!: (value: { response: string; sessionId: string; places: never[] }) => void
    const pendingSend = new Promise<{ response: string; sessionId: string; places: never[] }>(
      (resolve) => {
        resolveSend = resolve
      },
    )
    mocks.anonymousToken = '123e4567-e89b-42d3-a456-426614174022'
    mocks.getBySlug.mockResolvedValueOnce(characterVenue)
    mocks.client.chat.send.mutate.mockReturnValueOnce(pendingSend)

    render(<VenueChatExperience venueSlug="museum" presentation="standalone" />)

    expect(await screen.findByText('Here and ready')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
    expect(await screen.findByText('Listening')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }))
    expect(await screen.findByText('Thinking')).toBeTruthy()

    resolveSend({ response: 'Nearby.', sessionId: 'session-1', places: [] })
    expect(await screen.findByText('Response ready')).toBeTruthy()

    mocks.client.chat.send.mutate.mockRejectedValueOnce(new Error('network unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Send different message' }))
    expect(await screen.findByText('The character had a problem')).toBeTruthy()
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
    mocks.client.analytics.trackEvent.mutate.mockReturnValueOnce(undefined)
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
