'use client'

import { useEffect } from 'react'

import { CharacterRenderer } from './CharacterRenderer'
import { StaticCharacterFallback } from './StaticCharacterFallback'
import type { CharacterPresenceProps } from './character-types'

export function CharacterPresence({
  definition,
  manifest,
  context,
  onAssetError,
  ...renderProps
}: CharacterPresenceProps) {
  const contextSupported =
    definition.id === manifest.characterId &&
    definition.supportedContexts.includes(context) &&
    manifest.supportedContexts.includes(context)

  useEffect(() => {
    if (contextSupported) return
    onAssetError?.({
      code: 'unsupported-context',
      message: `Character ${definition.id} is not available in ${context}.`,
    })
  }, [context, contextSupported, definition.id, onAssetError])

  if (!contextSupported) {
    return (
      <StaticCharacterFallback
        manifest={manifest}
        size={renderProps.size}
        onAssetError={onAssetError}
      />
    )
  }

  return <CharacterRenderer manifest={manifest} onAssetError={onAssetError} {...renderProps} />
}
