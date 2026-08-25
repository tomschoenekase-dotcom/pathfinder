'use client'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'

import { TRPCProvider } from '../lib/trpc'
import type { NetworkConnectionState } from '../hooks/useNetworkStatus'
import { LocationRoutePlanner, type LocationRoutePlannerDataSource } from './LocationRoutePlanner'
import { VenueChatShell } from './VenueChatShell'
import { VoiceControlPanel } from './VoiceControl'
import type { ChatMessage, VenueSummary } from './venue-chat-types'

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
export type VisitorFixtureConversation = 'empty' | 'long'
export type VisitorFixtureAsset = 'ok' | 'missing'
export type VisitorFixtureVoice = 'none' | 'idle' | 'listening' | 'error'
export type VisitorFixtureRoute = 'none' | 'ready'

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

function fixtureVenue(mode: VisitorFixtureMode, asset: VisitorFixtureAsset): VenueSummary {
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
    guideMode: 'non_location',
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
}: {
  mode: VisitorFixtureMode
  state: (typeof VISITOR_FIXTURE_STATES)[number]
  conversation: VisitorFixtureConversation
  asset: VisitorFixtureAsset
  motion: 'system' | 'reduced' | 'full'
  voice?: VisitorFixtureVoice
  network?: NetworkConnectionState
  route?: VisitorFixtureRoute
}) {
  return (
    <TRPCProvider scopeKey="visitor-chat-visual-fixture">
      <div
        data-fixture="visitor-chat"
        data-fixture-mode={mode}
        data-fixture-state={state}
        data-fixture-conversation={conversation}
        data-fixture-asset={asset}
        data-fixture-voice={voice}
        data-fixture-network={network}
        data-fixture-route={route}
      >
        <VenueChatShell
          venue={fixtureVenue(mode, asset)}
          venueSlug="fixture-great-lakes-museum"
          presentation="standalone"
          messages={conversation === 'long' ? LONG_CONVERSATION : []}
          isSending={state === 'thinking'}
          sendError={state === 'error' ? 'The test response could not be loaded.' : null}
          anonymousToken="fixture-anonymous-token"
          language="English"
          setLanguage={() => undefined}
          initialDraft={state === 'listening' ? 'Tell me about the family exhibits' : ''}
          characterState={state}
          characterMotion={motion}
          connectionState={network}
          location={{ lat: null, lng: null, permission: 'prompt', refresh: () => undefined }}
          onSend={() => undefined}
          onRequestMore={() => undefined}
          requestMoreLabel="Tell me more"
          onDraftChange={() => undefined}
          onNewConversation={() => undefined}
          onPlaceView={() => undefined}
          onPlaceClick={() => undefined}
          onDirections={() => undefined}
          voiceControl={
            voice === 'none' ? null : (
              <VoiceControlPanel
                state={voice}
                disabled={false}
                error={
                  voice === 'error'
                    ? 'Microphone access was denied. You can continue in text or change browser permission and try again.'
                    : null
                }
                transcript={
                  voice === 'listening'
                    ? [{ speaker: 'ASSISTANT', text: 'What would you like to explore?' }]
                    : []
                }
                onStart={() => undefined}
                onEnd={() => undefined}
              />
            )
          }
          routePlanner={
            route === 'ready' ? (
              <LocationRoutePlanner
                venueId="fixture-great-lakes-museum"
                anonymousToken="123e4567-e89b-42d3-a456-426614174000"
                dataSource={FIXTURE_ROUTE_SOURCE}
              />
            ) : null
          }
        />
      </div>
    </TRPCProvider>
  )
}
