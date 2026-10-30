import type { VenueSourceRecord } from './venue-index'

/** Structural subset of an authorized guest place row (GuestDirectoryPlace or a fixture place). */
export type DirectoryPlaceLike = {
  id: string
  name: string
  type?: string | null
  itemType?: string | null
  shortDescription?: string | null
  longDescription?: string | null
  tags?: string[] | null
  areaName?: string | null
  hours?: string | null
}

/** Structural subset of an authorized guest knowledge row. */
export type DirectoryKnowledgeLike = {
  id: string
  title: string
  category?: string | null
  content: string
}

/**
 * Converts rows the guest may already read into index records. Callers pass only rows that passed
 * the guest directory's tenant, visibility and publication checks; this function adds no access.
 */
export function venueRecordsFromDirectory(params: {
  places: DirectoryPlaceLike[]
  knowledge: DirectoryKnowledgeLike[]
}): VenueSourceRecord[] {
  return [
    ...params.places.map(
      (place): VenueSourceRecord => ({
        id: `place:${place.id}`,
        source: 'place',
        title: place.name,
        body: place.longDescription || place.shortDescription || place.name,
        category: null,
        areaName: place.areaName ?? null,
        placeType: place.type ?? null,
        itemType: place.itemType ?? null,
        tags: place.tags ?? [],
        hours: place.hours ?? null,
      }),
    ),
    ...params.knowledge.map(
      (entry): VenueSourceRecord => ({
        id: `knowledge:${entry.id}`,
        source: 'knowledge',
        title: entry.title,
        body: entry.content,
        category: entry.category ?? null,
        areaName: null,
        placeType: null,
        itemType: null,
        tags: [],
        hours: null,
      }),
    ),
  ]
}
