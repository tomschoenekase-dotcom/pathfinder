import definitionData from '../../../../assets/characters/tochi/definition.json'
import manifestData from '../../../../assets/characters/tochi/v0-development/manifest.json'

import {
  CharacterRegistryEntrySchema,
  createPublicCharacterProjection,
  validateCharacterRegistry,
  type CharacterRegistryEntry,
  type PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'

/**
 * Trusted, code-reviewed system registry. Tenant configuration may select only
 * these definitions; it can never supply an arbitrary asset URL or manifest.
 * The current Tochi pack is deliberately non-publishable, so public resolution
 * returns null until reviewed final art changes the canonical manifest status.
 */
const SYSTEM_CHARACTER_REGISTRY = validateCharacterRegistry([
  CharacterRegistryEntrySchema.parse({
    definition: definitionData,
    manifests: [manifestData],
  }),
])

export function resolveApprovedCharacterProjection(
  entries: readonly CharacterRegistryEntry[],
  characterId: string | null,
): PublicCharacterProjection | null {
  if (!characterId) return null
  const entry = entries.find(({ definition }) => definition.id === characterId)
  if (!entry) return null
  const manifest = entry.manifests.find(
    ({ assetPackId }) => assetPackId === entry.definition.defaultAssetPackId,
  )
  return manifest ? createPublicCharacterProjection(entry.definition, manifest) : null
}

export function resolveSystemCharacterProjection(
  characterId: string | null,
): PublicCharacterProjection | null {
  return resolveApprovedCharacterProjection(SYSTEM_CHARACTER_REGISTRY, characterId)
}
