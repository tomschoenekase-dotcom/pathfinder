import { z } from 'zod'

import { KnowledgeEntryInput } from './knowledge'
import { PlaceInput } from './place'

export const VENUE_CONTENT_IMPORT_LIMIT = 500

export const ImportVenueContentInput = z
  .object({
    venueId: z.string().cuid(),
    idempotencyKey: z.string().uuid(),
    places: z.array(PlaceInput).max(VENUE_CONTENT_IMPORT_LIMIT),
    knowledgeEntries: z.array(KnowledgeEntryInput).max(VENUE_CONTENT_IMPORT_LIMIT),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.places.length + input.knowledgeEntries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Include at least one guide item or knowledge entry',
      })
    }

    input.places.forEach((place, index) => {
      if ((place.lat === undefined) !== (place.lng === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['places', index],
          message: 'Latitude and longitude must be supplied together',
        })
      }
    })
  })

export function canonicalVenueContentImportPayload(
  input: Pick<ImportVenueContentInput, 'venueId' | 'places' | 'knowledgeEntries'>,
): string {
  return JSON.stringify([
    'pathfinder:venue-content-import:canonical-v1',
    input.venueId,
    input.places.map((place) => [
      place.name,
      place.type,
      place.itemType ?? null,
      place.shortDescription ?? null,
      place.longDescription ?? null,
      place.lat ?? null,
      place.lng ?? null,
      place.tags,
      place.importanceScore,
      place.areaName ?? null,
      place.hours ?? null,
      place.photoUrl ?? null,
    ]),
    input.knowledgeEntries.map((entry) => [
      entry.title,
      entry.category,
      entry.content,
      entry.isEnabled,
    ]),
  ])
}

export type ImportVenueContentInput = z.infer<typeof ImportVenueContentInput>
