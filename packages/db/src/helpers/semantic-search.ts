import { Prisma } from '@prisma/client'

import { db } from '../client'

// Inlined here because packages/db cannot import from packages/api where the
// canonical version lives. Any change to the formula should be mirrored in
// packages/api/src/lib/geo.ts.
const EARTH_RADIUS_METERS = 6_371_000

function haversineDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export type SemanticPlace = {
  id: string
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  lat: number
  lng: number
  tags: string[]
  areaName: string | null
  hours: string | null
  photoUrl: string | null
  distanceMeters: number
}

type RawPlaceRow = {
  id: string
  name: string
  type: string
  short_description: string | null
  long_description: string | null
  lat: number
  lng: number
  tags: string[]
  area_name: string | null
  hours: string | null
  photo_url: string | null
}

const DEFAULT_LIMIT = 8

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
  const limitSafe = Prisma.raw(String(Math.max(1, Math.min(50, Math.floor(limit)))))

  const rows = await db.$queryRaw<RawPlaceRow[]>`
    SELECT
      id,
      name,
      type,
      short_description,
      long_description,
      lat,
      lng,
      tags,
      area_name,
      hours,
      photo_url
    FROM places
    WHERE venue_id     = ${venueId}
      AND tenant_id    = ${tenantId}
      AND is_active    = true
      AND embedding    IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limitSafe}
  `

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    shortDescription: row.short_description,
    longDescription: row.long_description,
    lat: Number(row.lat),
    lng: Number(row.lng),
    tags: row.tags ?? [],
    areaName: row.area_name,
    hours: row.hours,
    photoUrl: row.photo_url,
    distanceMeters: haversineDistanceMeters(userLat, userLng, Number(row.lat), Number(row.lng)),
  }))
}

/**
 * Stores a pre-computed embedding vector for a place.
 *
 * Raw SQL required: vector(1536) is unsupported by Prisma's typed API.
 * The placeId must have been obtained from a prior tenant-isolated query.
 */
export async function storePlaceEmbedding(placeId: string, embedding: number[]): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).$executeRaw`UPDATE places SET embedding = ${vectorStr}::vector WHERE id = ${placeId}`
}
