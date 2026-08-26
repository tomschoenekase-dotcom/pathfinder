import { notFound } from 'next/navigation'
import { SUPPORTED_CHAT_LANGUAGES } from '@pathfinder/api/schemas'

import {
  VenueChatFixture,
  type VisitorFixtureAsset,
  type VisitorFixtureConversation,
  type VisitorFixtureMode,
  type VisitorFixtureRoute,
  type VisitorFixtureVoice,
} from '../../../components/VenueChatFixture'

const VISITOR_FIXTURE_STATES = [
  'idle',
  'attention',
  'listening',
  'thinking',
  'speaking',
  'success',
  'error',
] as const

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
    language?: string | string[]
  }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const params = await searchParams
  const mode = oneOf(params.mode, ['classic', 'character'] as const, 'character')
  const state = oneOf(params.state, VISITOR_FIXTURE_STATES, 'idle')
  const conversation = oneOf(params.conversation, ['empty', 'long'] as const, 'empty')
  const asset = oneOf(params.asset, ['ok', 'missing'] as const, 'ok')
  const motion = oneOf(params.motion, ['system', 'reduced', 'full'] as const, 'system')
  const voice = oneOf(params.voice, ['none', 'idle', 'listening', 'error'] as const, 'none')
  const network = oneOf(params.network, ['online', 'offline', 'reconnected'] as const, 'online')
  const route = oneOf(params.route, ['none', 'ready'] as const, 'none')
  const language = oneOf(
    params.language,
    SUPPORTED_CHAT_LANGUAGES.map(({ label }) => label),
    'English',
  )

  return (
    <VenueChatFixture
      mode={mode satisfies VisitorFixtureMode}
      state={state}
      conversation={conversation satisfies VisitorFixtureConversation}
      asset={asset satisfies VisitorFixtureAsset}
      motion={motion}
      voice={voice satisfies VisitorFixtureVoice}
      network={network}
      route={route satisfies VisitorFixtureRoute}
      language={language}
    />
  )
}
