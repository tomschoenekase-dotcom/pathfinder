import OpenAI from 'openai'

import { env, logger } from '@pathfinder/config'
import { storePlaceEmbedding } from '@pathfinder/db'

// ---------------------------------------------------------------------------
// OpenAI client — module-level singleton
// ---------------------------------------------------------------------------

let _openai: OpenAI | null = null

function getOpenAIClient(): OpenAI {
  if (!_openai) {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured')
    }
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }
  return _openai
}

// Exported for test injection
export function _setOpenAIClientForTesting(client: OpenAI | null): void {
  _openai = client
}

// ---------------------------------------------------------------------------
// Text builder
// ---------------------------------------------------------------------------

/**
 * Concatenates all searchable fields of a place into a single string for
 * embedding. Order matters — name and type appear first so they weight highest
 * in the embedding space.
 */
export function buildPlaceText(place: {
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}): string {
  return [
    place.name,
    place.type,
    place.areaName,
    place.shortDescription,
    place.longDescription,
    place.tags.length > 0 ? place.tags.join(' ') : null,
    place.hours ? `Hours: ${place.hours}` : null,
  ]
    .filter(Boolean)
    .join('. ')
}

// ---------------------------------------------------------------------------
// Embedding generation
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

/**
 * Calls the OpenAI embeddings API and returns the raw float array.
 * Throws on failure — callers should catch if they want graceful degradation.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAIClient()
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return response.data[0]!.embedding
}

/**
 * Generates an embedding for the given place text and writes it to the DB.
 * Intended to be called after place create/update. Failures are caught and
 * logged so they never surface as a mutation error to the caller.
 *
 * Note: this is a synchronous external API call inside a web request, which is
 * normally forbidden by CLAUDE.md. It is acceptable here because:
 *   (a) it runs in an admin/dashboard mutation path, not a user-facing hot path
 *   (b) the try/catch ensures it cannot fail the parent mutation
 * TODO: migrate to a background job once the worker queue is active.
 */
export async function embedPlace(place: {
  id: string
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}): Promise<void> {
  try {
    const text = buildPlaceText(place)
    const embedding = await generateEmbedding(text)
    await storePlaceEmbedding(place.id, embedding)
  } catch (err) {
    logger.warn({
      action: 'place.embed.failed',
      placeId: place.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
