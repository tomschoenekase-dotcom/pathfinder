export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'

import { isFeatureEnabled } from '@pathfinder/config/feature-flags'
import {
  CHARACTER_PRESENTATION_CONTEXTS,
  CHARACTER_STATES,
  CharacterAssetManifestSchema,
  CharacterDefinitionSchema,
  type CharacterPresentationContext,
  type CharacterState,
} from '@pathfinder/contracts/character-system'
import type { CharacterSize } from '@pathfinder/ui/character'
import definitionData from '../../../../../../assets/characters/tochi/definition.json'
import manifestData from '../../../../../../assets/characters/tochi/v0-development/manifest.json'
import {
  CharacterLab,
  type CharacterLabInitialState,
} from '../../../../components/admin/CharacterLab'

type CharacterLabPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = Number(value)
  if (!Number.isFinite(candidate)) return fallback
  return Math.min(maximum, Math.max(minimum, candidate))
}

export default async function CharacterLabPage({ searchParams }: CharacterLabPageProps) {
  if (!isFeatureEnabled('characterRegistry')) notFound()

  const definition = CharacterDefinitionSchema.parse(definitionData)
  const manifest = CharacterAssetManifestSchema.parse(manifestData)
  const query = await searchParams
  const requestedState = first(query.state)
  const requestedContext = first(query.context)
  const requestedMotion = first(query.motion)
  const requestedBackground = first(query.background)
  const requestedViewport = first(query.viewport)
  const requestedSize = first(query.size)

  const initial: CharacterLabInitialState = {
    state: CHARACTER_STATES.includes(requestedState as CharacterState)
      ? (requestedState as CharacterState)
      : 'idle',
    context: CHARACTER_PRESENTATION_CONTEXTS.includes(
      requestedContext as CharacterPresentationContext,
    )
      ? (requestedContext as CharacterPresentationContext)
      : 'client-assistant',
    motion:
      requestedMotion === 'reduced' || requestedMotion === 'full' ? requestedMotion : 'system',
    background:
      requestedBackground === 'ink' ||
      requestedBackground === 'warm' ||
      requestedBackground === 'transparent'
        ? requestedBackground
        : 'mist',
    viewport:
      requestedViewport === 'mobile' || requestedViewport === 'tablet'
        ? requestedViewport
        : 'desktop',
    size:
      requestedSize === 'compact' || requestedSize === 'standard'
        ? (requestedSize as CharacterSize)
        : 'stage',
    intensity: boundedNumber(first(query.intensity), 0.6, 0, 1),
    lookAtX: boundedNumber(first(query.lookAtX), 0, -1, 1),
    lookAtY: boundedNumber(first(query.lookAtY), 0, -1, 1),
  }

  return <CharacterLab definition={definition} manifest={manifest} initial={initial} />
}
