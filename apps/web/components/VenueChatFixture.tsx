'use client'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'

import { VenueChatShell } from './VenueChatShell'
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
}: {
  mode: VisitorFixtureMode
  state: (typeof VISITOR_FIXTURE_STATES)[number]
  conversation: VisitorFixtureConversation
  asset: VisitorFixtureAsset
  motion: 'system' | 'reduced' | 'full'
}) {
  return (
    <div
      data-fixture="visitor-chat"
      data-fixture-mode={mode}
      data-fixture-state={state}
      data-fixture-conversation={conversation}
      data-fixture-asset={asset}
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
        location={{ lat: null, lng: null, permission: 'prompt', refresh: () => undefined }}
        onSend={() => undefined}
        onDraftChange={() => undefined}
        onNewConversation={() => undefined}
        onPlaceView={() => undefined}
        onPlaceClick={() => undefined}
        onDirections={() => undefined}
      />
    </div>
  )
}
