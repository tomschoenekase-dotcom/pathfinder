'use client'

import { useEffect, useState } from 'react'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { ChatAppearance } from '@pathfinder/contracts/chat-appearance'

import { TRPCProvider } from '../lib/trpc'
import type { NetworkConnectionState } from '../hooks/useNetworkStatus'
import { DEFAULT_VISITOR_PREFERENCES, type VisitorPreferences } from '../lib/visitor-preferences'
import { LocationRoutePlanner, type LocationRoutePlannerDataSource } from './LocationRoutePlanner'
import { VenueChatShell } from './VenueChatShell'
import { VoiceControlPanel } from './VoiceControl'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'

export const VISITOR_FIXTURE_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'success',
  'error',
] as const satisfies readonly CharacterState[]

export type VisitorFixtureMode = 'classic' | 'character'
export type VisitorFixtureConversation =
  | 'empty'
  | 'long'
  | 'multilingual'
  | 'streaming'
  | 'voice-history'
  | 'reference'
  | 'placeholder'
export type VisitorFixtureAsset = 'ok' | 'missing'
export type VisitorFixtureVoice =
  | 'none'
  | 'idle'
  | 'server'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'error'
export type VisitorFixtureRoute = 'none' | 'ready'
export type VisitorFixtureBranding = 'none' | 'approved'

const FIXTURE_ROUTE_SOURCE = {
  catalog: async () => ({
    locations: [
      {
        id: 'fixture-main-entrance',
        stableKey: 'main-entrance',
        kind: 'ENTRANCE' as const,
        displayName: 'Main entrance',
        floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
      },
      {
        id: 'fixture-lake-gallery',
        stableKey: 'lake-gallery',
        kind: 'EXHIBIT' as const,
        displayName: 'Lake gallery',
        floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
      },
    ],
  }),
  route: async (input) => ({
    from: {
      id: 'fixture-main-entrance',
      stableKey: 'main-entrance',
      kind: 'ENTRANCE' as const,
      displayName: 'Main entrance',
      floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
    },
    to: {
      id: 'fixture-lake-gallery',
      stableKey: 'lake-gallery',
      kind: 'EXHIBIT' as const,
      displayName: 'Lake gallery',
      floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
    },
    accessibleOnly: input.accessibleOnly,
    segmentCount: 2,
    describedSegmentCount: 2,
    guidanceConfidence: 'HIGH' as const,
    hasEquivalentRoute: true,
    review: {
      status: 'VENUE_REVIEWED' as const,
      reviewedAt: new Date('2026-08-19T12:00:00Z'),
    },
    segments: [
      {
        connectionId: 'fixture-lobby-walkway',
        kind: 'WALKWAY' as const,
        accessible: true,
        directions: 'Follow the lobby signs to the central lift.',
        from: {
          id: 'fixture-main-entrance',
          stableKey: 'main-entrance',
          kind: 'ENTRANCE' as const,
          displayName: 'Main entrance',
          floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
        },
        to: {
          id: 'fixture-central-lift',
          stableKey: 'central-lift',
          kind: 'SERVICE_DESK' as const,
          displayName: 'Central lift',
          floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
        },
      },
      {
        connectionId: 'fixture-upper-lift',
        kind: 'ELEVATOR' as const,
        accessible: true,
        directions: 'Take the lift to the upper floor and turn left.',
        from: {
          id: 'fixture-central-lift',
          stableKey: 'central-lift',
          kind: 'SERVICE_DESK' as const,
          displayName: 'Central lift',
          floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
        },
        to: {
          id: 'fixture-lake-gallery',
          stableKey: 'lake-gallery',
          kind: 'EXHIBIT' as const,
          displayName: 'Lake gallery',
          floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
        },
      },
    ],
  }),
} satisfies LocationRoutePlannerDataSource

export const VISITOR_FIXTURE_PROJECTION: PublicCharacterProjection = {
  characterId: 'tochi',
  displayName: 'Tochi',
  assetPackId: 'tochi-dev-v0',
  assetPackVersion: '0-development',
  renderer: 'static-image-v1',
  publicBasePath: '/characters/tochi/v0-development',
  assets: [
    {
      id: 'preview',
      path: 'preview.svg',
      mediaType: 'image/svg+xml',
      width: 320,
      height: 360,
      bytes: 1844,
    },
  ],
  canvas: { width: 320, height: 360 },
  anchors: { lookAt: { x: 160, y: 174 }, embers: { x: 160, y: 276 } },
  staticFallbackAssetId: 'preview',
  reducedMotionFallbackAssetId: 'preview',
  layers: {},
  states: {},
  stateFallbacks: {},
  supportedContexts: ['venue-text-chat'],
}

const LONG_CONVERSATION: ChatMessage[] = [
  { role: 'user', content: 'What should our family see first?' },
  {
    role: 'assistant',
    content:
      'Start with the lake gallery on the first floor. It is close to the entrance and usually takes about 25 minutes.',
  },
  { role: 'user', content: 'Is there a quiet place nearby afterward?' },
  {
    role: 'assistant',
    content:
      "The reading room beside the north stair is the quietest public space. Venue staff can confirm today's availability.",
  },
]

/**
 * Neutral sample used by the client portal's appearance preview. Both speakers use the same
 * placeholder language so the preview shows styling, never invented venue facts.
 */
const PLACEHOLDER_CONVERSATION: ChatMessage[] = [
  { role: 'user', content: 'Lorem ipsum dolor sit amet?' },
  {
    role: 'assistant',
    content:
      'Consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
  },
  { role: 'user', content: 'Quis nostrud exercitation ullamco laboris?' },
  {
    role: 'assistant',
    content:
      'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  },
]

/** The exchange from the approved visitor-guide reference screenshot. */
const REFERENCE_CONVERSATION: ChatMessage[] = [
  { role: 'user', content: "I'm a 10 year old boy. What will I like?" },
  {
    role: 'assistant',
    content:
      "If you mean what you might like at the museum, Max Q the robot is a popular choice—ask a staff member to show you what he can do, and don't touch his control tablet. You could also try lifting the gravity bricks to feel how the same brick would weigh on the Moon or Mars.",
  },
]

const MULTILINGUAL_CONVERSATION: ChatMessage[] = [
  {
    role: 'user',
    content: 'هل يمكنك اقتراح مسار هادئ ومناسب للكراسي المتحركة من المدخل إلى معرض البحيرة؟',
  },
  {
    role: 'assistant',
    content:
      'نعم. ابدأ من المدخل الرئيسي، واتبع علامات الردهة إلى المصعد المركزي، ثم انعطف يسارًا في الطابق العلوي. يمكن لموظفي المكان تأكيد حالة المصعد اليوم.',
  },
  {
    role: 'user',
    content: '子どもと一緒に休憩できる場所も近くにありますか？',
  },
  {
    role: 'assistant',
    content:
      '北階段の横に読書ルームがあります。本日利用できるかどうかは、会場スタッフにご確認ください。',
  },
]

const STREAMING_CONVERSATION: ChatMessage[] = [
  { role: 'user', content: 'Where can we find the lake ecology gallery?' },
  {
    role: 'assistant',
    content: 'The lake ecology gallery is on the upper floor beside the central',
  },
]

const VOICE_HISTORY_CONVERSATION: ChatMessage[] = [
  {
    id: 'fixture-text-before-voice',
    role: 'assistant',
    content: 'I can help you find a quieter route.',
  },
  {
    id: 'voice:fixture-visitor-segment',
    role: 'user',
    content: 'Can we avoid the busy central stairs?',
    voiceDelivery: 'CAPTURED',
  },
  {
    id: 'voice:fixture-assistant-segment',
    role: 'assistant',
    content: 'Take the east corridor past the family lounge, then use the accessible lift.',
    voiceDelivery: 'INTERRUPTED',
  },
]

function fixtureVenue(
  mode: VisitorFixtureMode,
  asset: VisitorFixtureAsset,
  guideMode: 'non_location' | 'location_aware',
): VenueSummary {
  const projection =
    asset === 'ok'
      ? VISITOR_FIXTURE_PROJECTION
      : {
          ...VISITOR_FIXTURE_PROJECTION,
          publicBasePath: '/characters/tochi/missing-fixture',
        }

  return {
    id: 'fixture-great-lakes-museum',
    name: 'Great Lakes Discovery Museum',
    description: 'Explore lake ecology, shipping history, and hands-on family exhibits.',
    category: 'museum',
    guideMode,
    defaultCenterLat: null,
    defaultCenterLng: null,
    aiGuideName: 'Museum Guide',
    chatTheme: 'light',
    chatAccentColor: null,
    chatFont: null,
    chatLogoUrl: null,
    chatBannerUrl: null,
    venueBotPresentation:
      mode === 'character'
        ? {
            mode: 'CHARACTER',
            displayName: 'Museum Tochi',
            greeting: 'Ask me anything about your visit.',
            personalityPreset: 'friendly',
            character: projection,
          }
        : {
            mode: 'CLASSIC',
            displayName: null,
            greeting: null,
            personalityPreset: 'friendly',
            character: null,
          },
  }
}

export function VenueChatFixture({
  mode,
  state,
  conversation,
  asset,
  motion,
  voice = 'none',
  network = 'online',
  route = 'none',
  guideMode = 'non_location',
  language = 'English',
  theme,
  font,
  accent,
  branding = 'none',
  readOnly = false,
  presentation = 'standalone',
  appHeader = 'full',
  booting = false,
  appearance,
  backgroundUrl,
  logoUrl,
  venueName,
  preferences = DEFAULT_VISITOR_PREFERENCES,
}: {
  mode: VisitorFixtureMode
  state: (typeof VISITOR_FIXTURE_STATES)[number]
  conversation: VisitorFixtureConversation
  asset: VisitorFixtureAsset
  motion: 'system' | 'reduced' | 'full'
  voice?: VisitorFixtureVoice
  network?: NetworkConnectionState
  route?: VisitorFixtureRoute
  guideMode?: 'non_location' | 'location_aware'
  language?: SupportedChatLanguage
  theme?: string | undefined
  font?: string | undefined
  accent?: string | undefined
  branding?: VisitorFixtureBranding
  readOnly?: boolean
  presentation?: VenueChatPresentation
  appHeader?: 'full' | 'compact' | 'none'
  booting?: boolean
  appearance?: ChatAppearance
  /** Same-origin reviewed background image used with an `image` appearance. */
  backgroundUrl?: string
  /** Same-origin reviewed logo, or a local draft image in the portal's preview. */
  logoUrl?: string
  venueName?: string
  preferences?: VisitorPreferences
}) {
  const [fixturePreferences, setFixturePreferences] = useState(preferences)
  const [clientMounted, setClientMounted] = useState(false)

  useEffect(() => {
    setClientMounted(true)
  }, [])

  return (
    <TRPCProvider scopeKey="visitor-chat-visual-fixture">
      <div
        data-fixture="visitor-chat"
        data-fixture-client-mounted={clientMounted}
        data-fixture-mode={mode}
        data-fixture-state={state}
        data-fixture-conversation={conversation}
        data-fixture-asset={asset}
        data-fixture-voice={voice}
        data-fixture-network={network}
        data-fixture-presentation={presentation}
        data-fixture-app-header={appHeader}
        data-fixture-booting={booting}
        data-fixture-route={route}
        data-fixture-branding={branding}
      >
        <VenueChatShell
          venue={{
            ...fixtureVenue(mode, asset, guideMode),
            ...(theme ? { chatTheme: theme } : {}),
            ...(font ? { chatFont: font } : {}),
            ...(accent ? { chatAccentColor: accent } : {}),
            ...(branding === 'approved'
              ? {
                  chatLogoUrl: '/dev-fixtures/visitor-brand-logo.svg',
                  chatBannerUrl: '/dev-fixtures/visitor-brand-banner.svg',
                }
              : {}),
            ...(backgroundUrl ? { chatBannerUrl: backgroundUrl } : {}),
            ...(logoUrl ? { chatLogoUrl: logoUrl } : {}),
            ...(appearance ? { chatAppearance: appearance } : {}),
            ...(venueName ? { name: venueName } : {}),
          }}
          preferences={fixturePreferences}
          onPreferencesChange={(change) =>
            setFixturePreferences((current) => ({ ...current, ...change }))
          }
          venueSlug="fixture-great-lakes-museum"
          presentation={presentation}
          appHeader={appHeader}
          messages={
            voice === 'interrupted'
              ? VOICE_HISTORY_CONVERSATION
              : conversation === 'long'
                ? LONG_CONVERSATION
                : conversation === 'placeholder'
                  ? PLACEHOLDER_CONVERSATION
                  : conversation === 'reference'
                    ? REFERENCE_CONVERSATION
                    : conversation === 'multilingual'
                      ? MULTILINGUAL_CONVERSATION
                      : conversation === 'streaming'
                        ? STREAMING_CONVERSATION
                        : conversation === 'voice-history'
                          ? VOICE_HISTORY_CONVERSATION
                          : []
          }
          isSending={state === 'thinking' || state === 'speaking'}
          isRestoringHistory={booting}
          conversationLocked={readOnly}
          sendError={state === 'error' ? 'The test response could not be loaded.' : null}
          anonymousToken="fixture-anonymous-token"
          language={language}
          initialDraft={state === 'listening' ? 'Tell me about the family exhibits' : ''}
          characterState={state}
          characterMotion={motion}
          connectionState={network}
          location={{ lat: null, lng: null, permission: 'prompt', refresh: () => undefined }}
          onSend={() => undefined}
          onRequestMore={() => undefined}
          requestMoreLabel="Tell me more about that"
          onDraftChange={() => undefined}
          onNewConversation={() => undefined}
          onPlaceView={() => undefined}
          onPlaceClick={() => undefined}
          onDirections={() => undefined}
          voiceControl={
            voice === 'server' ? undefined : voice === 'none' ? null : (
              <VoiceControlPanel
                state={voice === 'interrupted' ? 'speaking' : voice}
                disabled={false}
                compact
                error={
                  voice === 'error'
                    ? 'Microphone access was denied. You can continue in text or change browser permission and try again.'
                    : null
                }
                transcript={
                  voice === 'speaking' || voice === 'interrupted'
                    ? [
                        { speaker: 'VISITOR', text: 'Where should we begin?' },
                        {
                          speaker: 'ASSISTANT',
                          text: 'Start in the lake gallery.',
                          delivery: 'PLAYED',
                        },
                        { speaker: 'VISITOR', text: 'Is there a quieter route?' },
                        {
                          speaker: 'ASSISTANT',
                          text: 'Yes. Take the east lift and follow the blue signs.',
                          delivery: 'PLAYED',
                        },
                      ]
                    : voice === 'listening'
                      ? [{ speaker: 'ASSISTANT', text: 'What would you like to explore?' }]
                      : []
                }
                onStart={() => undefined}
                onEnd={() => undefined}
              />
            )
          }
          fixtureLiveVoiceCaption={
            voice === 'speaking' || voice === 'interrupted'
              ? {
                  responseId: 'fixture-live-caption',
                  text: 'The quieter route continues past the family lounge, then turns left toward the accessible east lift. From there, follow the blue signs along the quieter east corridor. The next landmark is the glass reading room, just beyond the family displays. If the corridor feels busy, pause near the small seating area beside the lift; the route continues straight after the doorway and avoids the central stairs. You can also ask me to repeat any part of these directions while we walk together.',
                  interrupted: voice === 'interrupted',
                }
              : null
          }
          fixtureLiveVoiceAnnouncement={
            voice === 'interrupted'
              ? 'Voice response interrupted. Finalizing caption.'
              : voice === 'speaking'
                ? 'Voice caption started.'
                : null
          }
          routePlanner={
            route === 'ready' ? (
              <LocationRoutePlanner
                venueId="fixture-great-lakes-museum"
                anonymousToken="123e4567-e89b-42d3-a456-426614174000"
                dataSource={FIXTURE_ROUTE_SOURCE}
                language={language}
              />
            ) : null
          }
        />
      </div>
    </TRPCProvider>
  )
}
