'use client'

import { useEffect } from 'react'

import { CharacterRenderer } from './CharacterRenderer'
import { StaticCharacterFallback } from './StaticCharacterFallback'
import type { PublicCharacterPresenceProps } from './character-types'

export function PublicCharacterPresence({
  projection,
  context,
  onAssetError,
  ...renderProps
}: PublicCharacterPresenceProps) {
  const contextSupported = projection.supportedContexts.includes(context)

  useEffect(() => {
    if (contextSupported) return
    onAssetError?.({
      code: 'unsupported-context',
      message: `Character ${projection.characterId} is not available in ${context}.`,
    })
  }, [context, contextSupported, onAssetError, projection.characterId])

  if (!contextSupported) {
    return (
      <StaticCharacterFallback
        manifest={projection}
        size={renderProps.size}
        onAssetError={onAssetError}
      />
    )
  }

  return <CharacterRenderer manifest={projection} onAssetError={onAssetError} {...renderProps} />
}
