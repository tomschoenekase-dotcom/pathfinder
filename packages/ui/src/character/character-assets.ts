import type { CharacterAssetReference } from '@pathfinder/contracts/character-system'

import type { CharacterRenderableManifest } from './character-types'

export function findCharacterAsset(
  manifest: CharacterRenderableManifest,
  assetId: string | undefined,
): CharacterAssetReference | undefined {
  if (!assetId) return undefined
  return manifest.assets.find((asset) => asset.id === assetId)
}

export function getCharacterAssetSource(
  manifest: CharacterRenderableManifest,
  asset: CharacterAssetReference,
) {
  return `${manifest.publicBasePath}/${asset.path}`
}
