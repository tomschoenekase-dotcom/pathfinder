import type {
  CharacterAssetManifest,
  CharacterDefinition,
  CharacterPresentationContext,
  CharacterState,
  PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'

export type CharacterMotion = 'system' | 'reduced' | 'full'
export type CharacterSize = 'compact' | 'standard' | 'stage'

export type CharacterAssetErrorCode =
  | 'unsupported-context'
  | 'unsupported-renderer'
  | 'layer-load-failed'
  | 'static-load-failed'
  | 'brand-load-failed'

export type CharacterAssetError = {
  code: CharacterAssetErrorCode
  message: string
  assetId?: string
  path?: string
}

export type CharacterPresenceProps = {
  definition: CharacterDefinition
  manifest: CharacterAssetManifest
  state: CharacterState
  context: CharacterPresentationContext
  motion: CharacterMotion
  intensity?: number | undefined
  lookAt?: { x: number; y: number } | undefined
  size?: CharacterSize | undefined
  onAssetError?: ((error: CharacterAssetError) => void) | undefined
}

export type CharacterRenderableManifest = CharacterAssetManifest | PublicCharacterProjection

export type CharacterRenderProps = Omit<
  CharacterPresenceProps,
  'definition' | 'context' | 'manifest'
> & {
  manifest: CharacterRenderableManifest
}

export type PublicCharacterPresenceProps = Omit<
  CharacterPresenceProps,
  'definition' | 'manifest'
> & {
  projection: PublicCharacterProjection
}
