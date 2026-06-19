import OpenAI from 'openai'

import { env } from '@pathfinder/config'

import { storePlaceEmbedding } from './semantic-search'

let openaiClient: OpenAI | null = null

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured')
    }

    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }

  return openaiClient
}

export function setOpenAIClientForTesting(client: OpenAI | null): void {
  openaiClient = client
}

export function buildPlaceText(place: {
  name: string
  type: string
  itemType?: string | null
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  areaName: string | null
  hours: string | null
}): string {
  return [
    place.name,
    place.itemType ?? place.type,
    place.areaName,
    place.shortDescription,
    place.longDescription,
    place.tags.length > 0 ? place.tags.join(' ') : null,
    place.hours ? `Hours: ${place.hours}` : null,
  ]
    .filter(Boolean)
    .join('. ')
}

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getOpenAIClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })

  return response.data[0]!.embedding
}

export async function generateAndStorePlaceEmbedding(place: {
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
  const text = buildPlaceText(place)
  const embedding = await generateEmbedding(text)

  await storePlaceEmbedding(place.id, embedding)
}
