import { notFound } from 'next/navigation'
import { SUPPORTED_CHAT_LANGUAGES } from '@pathfinder/api/schemas'
import { CHAT_FONT_OPTIONS } from '@pathfinder/ui/theme'
import {
  DEFAULT_CHAT_APPEARANCE,
  decodeChatAppearanceParam,
  type ChatAppearance,
} from '@pathfinder/contracts/chat-appearance'

import {
  VenueChatFixture,
  type VisitorFixtureAsset,
  type VisitorFixtureBranding,
  type VisitorFixtureConversation,
  type VisitorFixtureMode,
  type VisitorFixtureRoute,
  type VisitorFixtureVoice,
} from '../../../components/VenueChatFixture'
import { VenueChatError, VenueChatSkeleton } from '../../../components/VenueChatStates'
import { VenueTemporarilyUnavailable } from '../../../components/VenueTemporarilyUnavailable'
import { parsePlaceActionLabel } from '../../../lib/host-bridge'
import { FixtureHostPlaceAction } from './FixtureHostPlaceAction'

const VISITOR_FIXTURE_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'success',
  'error',
] as const

/** Named looks so rendered QA can exercise the appearance matrix without encoding JSON. */
const FIXTURE_LOOKS: Record<string, ChatAppearance> = {
  plain: DEFAULT_CHAT_APPEARANCE,
  bubbles: { ...DEFAULT_CHAT_APPEARANCE, assistantBubble: true },
  labels: { ...DEFAULT_CHAT_APPEARANCE, userBubble: false, assistantBubble: false },
  photo: {
    ...DEFAULT_CHAT_APPEARANCE,
    headerColor: '#0B1426',
    assistantSurfaceColor: '#101B33',
    userBubbleColor: '#2C4777',
    background: { mode: 'image', focalX: 70, focalY: 60, dim: 35 },
  },
  'photo-labels': {
    ...DEFAULT_CHAT_APPEARANCE,
    userBubble: false,
    assistantBubble: false,
    headerColor: '#0B1426',
    background: { mode: 'image', focalX: 70, focalY: 60, dim: 35 },
  },
  'no-more': { ...DEFAULT_CHAT_APPEARANCE, requestMore: false },
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function oneOf<const T extends readonly string[]>(
  value: string | string[] | undefined,
  choices: T,
  fallback: T[number],
): T[number] {
  const candidate = first(value)
  return choices.includes(candidate ?? '') ? (candidate as T[number]) : fallback
}

export default async function VisitorChatVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{
    mode?: string | string[]
    state?: string | string[]
    conversation?: string | string[]
    asset?: string | string[]
    motion?: string | string[]
    voice?: string | string[]
    network?: string | string[]
    route?: string | string[]
    guideMode?: string | string[]
    language?: string | string[]
    surface?: string | string[]
    theme?: string | string[]
    font?: string | string[]
    accent?: string | string[]
    branding?: string | string[]
    presentation?: string | string[]
    appHeader?: string | string[]
    booting?: string | string[]
    look?: string | string[]
    appearance?: string | string[]
    venueName?: string | string[]
    textSize?: string | string[]
    contrast?: string | string[]
    placeAction?: string | string[]
  }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const params = await searchParams
  const mode = oneOf(params.mode, ['classic', 'character'] as const, 'character')
  const state = oneOf(params.state, VISITOR_FIXTURE_STATES, 'idle')
  const conversation = oneOf(
    params.conversation,
    ['empty', 'long', 'multilingual', 'streaming', 'voice-history', 'reference', 'pass'] as const,
    'empty',
  )
  const asset = oneOf(params.asset, ['ok', 'missing'] as const, 'ok')
  const motion = oneOf(params.motion, ['system', 'reduced', 'full'] as const, 'system')
  const voice = oneOf(
    params.voice,
    ['none', 'idle', 'listening', 'speaking', 'interrupted', 'error'] as const,
    'none',
  )
  const network = oneOf(params.network, ['online', 'offline', 'reconnected'] as const, 'online')
  const route = oneOf(params.route, ['none', 'ready'] as const, 'none')
  const guideMode = oneOf(
    params.guideMode,
    ['non_location', 'location_aware'] as const,
    'non_location',
  )
  const branding = oneOf(params.branding, ['none', 'approved'] as const, 'none')
  const presentation = oneOf(
    params.presentation,
    ['standalone', 'embed', 'embed-inline', 'webview'] as const,
    'standalone',
  )
  const appHeader = oneOf(params.appHeader, ['full', 'compact', 'none'] as const, 'full')
  const language = oneOf(
    params.language,
    SUPPORTED_CHAT_LANGUAGES.map(({ label }) => label),
    'English',
  )
  const surface = oneOf(
    params.surface,
    ['chat', 'loading', 'error', 'temporarily-unavailable'] as const,
    'chat',
  )

  const appearance =
    decodeChatAppearanceParam(first(params.appearance)) ??
    FIXTURE_LOOKS[first(params.look) ?? ''] ??
    undefined
  const venueName = first(params.venueName)?.slice(0, 160)
  const placeActionLabel =
    presentation === 'webview' ? parsePlaceActionLabel(first(params.placeAction)) : undefined

  if (surface === 'loading') return <VenueChatSkeleton language={language} />
  if (surface === 'error')
    return (
      <VenueChatError
        message="This venue link is not active."
        presentation="standalone"
        language={language}
      />
    )
  if (surface === 'temporarily-unavailable')
    return <VenueTemporarilyUnavailable language={language} />

  return (
    <FixtureHostPlaceAction label={placeActionLabel}>
      <VenueChatFixture
        mode={mode satisfies VisitorFixtureMode}
        state={state}
        conversation={conversation satisfies VisitorFixtureConversation}
        asset={asset satisfies VisitorFixtureAsset}
        motion={motion}
        voice={voice satisfies VisitorFixtureVoice}
        network={network}
        route={route satisfies VisitorFixtureRoute}
        guideMode={guideMode}
        language={language}
        theme={first(params.theme)}
        font={oneOf(
          params.font,
          CHAT_FONT_OPTIONS.map((font) => font.value),
          'jakarta',
        )}
        accent={first(params.accent)}
        branding={branding satisfies VisitorFixtureBranding}
        presentation={presentation}
        appHeader={appHeader}
        booting={first(params.booting) === 'true'}
        {...(appearance ? { appearance } : {})}
        {...(appearance?.background.mode === 'image'
          ? { backgroundUrl: '/dev-fixtures/visitor-backdrop-space.svg' }
          : {})}
        {...(venueName ? { venueName } : {})}
        preferences={{
          textSize: oneOf(params.textSize, ['standard', 'large', 'larger'] as const, 'standard'),
          language: 'auto',
          highContrast: first(params.contrast) === 'high',
        }}
      />
    </FixtureHostPlaceAction>
  )
}
