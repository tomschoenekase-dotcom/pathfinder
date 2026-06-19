import { logger } from '@pathfinder/config'
import {
  buildPlaceText,
  generateAndStorePlaceEmbedding,
  generateEmbedding,
  setOpenAIClientForTesting,
} from '@pathfinder/db'

export { buildPlaceText, generateEmbedding }

export function _setOpenAIClientForTesting(
  client: Parameters<typeof setOpenAIClientForTesting>[0],
): void {
  setOpenAIClientForTesting(client)
}

/**
 * Compatibility helper for tests and scripts. Request paths should enqueue
 * embed-place jobs instead of calling this directly.
 */
export async function embedPlace(place: {
  id: string
  name: string
  type: string
  itemType?: string | null
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}): Promise<void> {
  try {
    await generateAndStorePlaceEmbedding(place)
  } catch (err) {
    logger.warn({
      action: 'place.embed.failed',
      placeId: place.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
