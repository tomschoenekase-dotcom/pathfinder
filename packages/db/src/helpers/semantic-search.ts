import { db } from '../client'
import { haversineDistanceMeters } from '@pathfinder/config/geo'

export type SemanticPlace = {
  id: string
  name: string
  type: string
  itemType: string | null
  shortDescription: string | null
  longDescription: string | null
  lat: number | null
  lng: number | null
  tags: string[]
  areaName: string | null
  hours: string | null
  photoUrl: string | null
  distanceMeters?: number
  // pgvector cosine distance of this place's embedding from the query embedding
  // (0 = identical, ~1 = orthogonal). Reused as a free retrieval-confidence proxy.
  // Optional because the geo-importance fallback path has no semantic score.
  distance?: number
}

type RawPlaceRow = {
  id: string
  name: string
  type: string
  item_type: string | null
  short_description: string | null
  long_description: string | null
  lat: number | null
  lng: number | null
  tags: string[]
  area_name: string | null
  hours: string | null
  photo_url: string | null
  distance: number
}

const DEFAULT_LIMIT = 8
const KNOWLEDGE_DEFAULT_LIMIT = 5

export type SemanticKnowledgeEntry = {
  id: string
  title: string
  category: string
  content: string
  distance: number
}

type RawKnowledgeRow = {
  id: string
  title: string
  category: string
  content: string
  distance: number
}

/**
 * Searches places by cosine similarity against a pre-computed query embedding.
 * Returns places ranked by semantic relevance, each annotated with haversine
 * distance from the user's position.
 *
 * Raw SQL required: pgvector cosine similarity operator (<=>).
 * tenant_id is explicitly bound as a query parameter — isolation is manual here
 * since $queryRaw bypasses the Prisma middleware.
 */
export async function searchPlacesByEmbedding(params: {
  queryEmbedding: number[]
  venueId: string
  tenantId: string
  userLat: number
  userLng: number
  limit?: number
}): Promise<SemanticPlace[]> {
  const { queryEmbedding, venueId, tenantId, userLat, userLng, limit = DEFAULT_LIMIT } = params

  const vectorStr = `[${queryEmbedding.join(',')}]`
  const limitSafe = Math.max(1, Math.min(50, Math.floor(limit)))

  const rows = await db.$queryRaw<RawPlaceRow[]>`
    SELECT
      id,
      name,
      type,
      item_type,
      short_description,
      long_description,
      lat,
      lng,
      tags,
      area_name,
      hours,
      photo_url,
      embedding <=> ${vectorStr}::vector AS distance
    FROM places
    WHERE venue_id     = ${venueId}
      AND tenant_id    = ${tenantId}
      AND is_active    = true
      AND embedding    IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limitSafe}
  `

  return rows.map((row: RawPlaceRow) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    itemType: row.item_type,
    shortDescription: row.short_description,
    longDescription: row.long_description,
    lat: row.lat,
    lng: row.lng,
    tags: row.tags ?? [],
    areaName: row.area_name,
    hours: row.hours,
    photoUrl: row.photo_url,
    distance: Number(row.distance),
    ...(row.lat != null && row.lng != null
      ? { distanceMeters: haversineDistanceMeters(userLat, userLng, row.lat, row.lng) }
      : {}),
  }))
}

/** Stores a place embedding only while scope and captured content still match. */
export async function storePlaceEmbeddingForScope(params: {
  placeId: string
  tenantId: string
  venueId: string
  contentUpdatedAt: Date
  source: {
    name: string
    type: string
    itemType: string | null
    shortDescription: string | null
    longDescription: string | null
    tags: string[]
    areaName: string | null
    hours: string | null
    isActive: boolean
  }
  embedding: number[]
}): Promise<boolean> {
  const vectorStr = `[${params.embedding.join(',')}]`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await (db as any).$executeRaw`
    UPDATE places
    SET embedding = ${vectorStr}::vector
    WHERE id = ${params.placeId}
      AND tenant_id = ${params.tenantId}
      AND venue_id = ${params.venueId}
      AND updated_at = ${params.contentUpdatedAt}
      AND name = ${params.source.name}
      AND type = ${params.source.type}
      AND item_type IS NOT DISTINCT FROM ${params.source.itemType}
      AND short_description IS NOT DISTINCT FROM ${params.source.shortDescription}
      AND long_description IS NOT DISTINCT FROM ${params.source.longDescription}
      AND tags = ${params.source.tags}
      AND area_name IS NOT DISTINCT FROM ${params.source.areaName}
      AND hours IS NOT DISTINCT FROM ${params.source.hours}
      AND is_active = ${params.source.isActive}
  `
  return updated === 1
}

/**
 * Searches knowledge entries by cosine similarity against a pre-computed query embedding.
 *
 * Raw SQL required: pgvector cosine similarity operator (<=>).
 * tenant_id is explicitly bound as a query parameter; isolation is manual here
 * since $queryRaw bypasses the Prisma middleware.
 */
export async function searchKnowledgeByEmbedding(params: {
  queryEmbedding: number[]
  venueId: string
  tenantId: string
  limit?: number
}): Promise<SemanticKnowledgeEntry[]> {
  const { queryEmbedding, venueId, tenantId, limit = KNOWLEDGE_DEFAULT_LIMIT } = params

  const vectorStr = `[${queryEmbedding.join(',')}]`
  const limitSafe = Math.max(1, Math.min(20, Math.floor(limit)))

  const rows = await db.$queryRaw<RawKnowledgeRow[]>`
    SELECT
      id,
      title,
      category,
      content,
      embedding <=> ${vectorStr}::vector AS distance
    FROM venue_knowledge_entries
    WHERE venue_id   = ${venueId}
      AND tenant_id  = ${tenantId}
      AND is_enabled = true
      AND embedding  IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limitSafe}
  `

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    content: row.content,
    distance: Number(row.distance),
  }))
}

/** Stores a knowledge embedding only while scope and captured content still match. */
export async function storeKnowledgeEntryEmbeddingForScope(params: {
  entryId: string
  tenantId: string
  venueId: string
  contentUpdatedAt: Date
  source: {
    title: string
    category: string
    content: string
    isEnabled: boolean
  }
  embedding: number[]
}): Promise<boolean> {
  const vectorStr = `[${params.embedding.join(',')}]`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await (db as any).$executeRaw`
    UPDATE venue_knowledge_entries
    SET embedding = ${vectorStr}::vector
    WHERE id = ${params.entryId}
      AND tenant_id = ${params.tenantId}
      AND venue_id = ${params.venueId}
      AND updated_at = ${params.contentUpdatedAt}
      AND title = ${params.source.title}
      AND category = ${params.source.category}
      AND content = ${params.source.content}
      AND is_enabled = ${params.source.isEnabled}
  `
  return updated === 1
}
