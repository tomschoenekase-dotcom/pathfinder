'use client'

import { useEffect, useState } from 'react'

import type {
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'
import { PublicCharacterPresence } from '@pathfinder/ui/character'

const STATE_LABELS: Record<CharacterState, string> = {
  idle: 'Ready to help',
  attention: 'Here and ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  success: 'Response ready',
  processing: 'Working on it',
  uploadReceiving: 'Receiving an upload',
  uploadComplete: 'Upload received',
  question: 'Has a question',
  handoff: 'Preparing a handoff',
  error: 'The character had a problem',
  sleeping: 'Resting',
  minimized: 'Minimized',
}

export type VenueCharacterStageProps = {
  projection: PublicCharacterProjection
  state: CharacterState
  displayName: string | null
  greeting: string | null
  expanded: boolean
  motion?: 'system' | 'reduced' | 'full'
}

export function VenueCharacterStage({
  projection,
  state,
  displayName,
  greeting,
  expanded,
  motion = 'system',
}: VenueCharacterStageProps) {
  const [assetFailed, setAssetFailed] = useState(false)
  const name = displayName ?? projection.displayName
  const stateLabel = assetFailed
    ? 'Character display unavailable; text chat is ready'
    : STATE_LABELS[state]

  useEffect(() => {
    setAssetFailed(false)
  }, [projection.assetPackId, projection.assetPackVersion])

  return (
    <section
      className={`grid items-center gap-3 overflow-hidden rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 shadow-sm ${
        expanded
          ? 'min-h-28 grid-cols-[minmax(5rem,7rem)_1fr] py-3 sm:grid-cols-[8rem_1fr]'
          : 'min-h-16 grid-cols-[3.5rem_1fr] py-2'
      }`}
      aria-label={`${name} character status`}
      data-character-state={state}
      data-character-layout={expanded ? 'expanded' : 'compact'}
    >
      <div
        className={`flex items-center justify-center overflow-hidden ${expanded ? 'h-24 max-h-[20svh]' : 'h-12'}`}
      >
        <PublicCharacterPresence
          projection={projection}
          state={state}
          context="venue-text-chat"
          motion={motion}
          size={expanded ? 'stage' : 'compact'}
          onAssetError={() => setAssetFailed(true)}
        />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[var(--chat-text)]">{name}</p>
        <p className="mt-0.5 text-xs font-medium text-[var(--chat-accent-text)]">{stateLabel}</p>
        {expanded && greeting ? (
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--chat-text-muted)]">
            {greeting}
          </p>
        ) : null}
      </div>
    </section>
  )
}
