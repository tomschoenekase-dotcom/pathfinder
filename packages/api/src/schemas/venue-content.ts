import { z } from 'zod'

import { KnowledgeEntryInput } from './knowledge'
import { PlaceInput } from './place'

export const VENUE_CONTENT_IMPORT_LIMIT = 500

export const ImportVenueContentInput = z
  .object({
    venueId: z.string().cuid(),
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

export type ImportVenueContentInput = z.infer<typeof ImportVenueContentInput>
