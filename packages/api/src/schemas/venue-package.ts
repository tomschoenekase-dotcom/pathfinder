import { z } from 'zod'

import { KnowledgeEntryInput } from './knowledge'
import { PlaceInput } from './place'
import { VENUE_CONTENT_IMPORT_LIMIT, canonicalVenueContentImportPayload } from './venue-content'

export const VENUE_PACKAGE_SCHEMA_VERSION = 1 as const
export const VENUE_PACKAGE_ITEM_LIMIT = VENUE_CONTENT_IMPORT_LIMIT

export const VenuePackagePayload = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION),
    places: z.array(PlaceInput).max(VENUE_CONTENT_IMPORT_LIMIT),
    knowledgeEntries: z.array(KnowledgeEntryInput.strict()).max(VENUE_CONTENT_IMPORT_LIMIT),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.places.length + input.knowledgeEntries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Include at least one guide item or knowledge entry',
      })
    }

    if (input.places.length + input.knowledgeEntries.length > VENUE_PACKAGE_ITEM_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: VENUE_PACKAGE_ITEM_LIMIT,
        type: 'array',
        inclusive: true,
        message: `A venue package can contain at most ${VENUE_PACKAGE_ITEM_LIMIT} total items`,
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

export const VenuePackagePreviewInput = z
  .object({
    venueId: z.string().cuid(),
    payload: VenuePackagePayload,
  })
  .strict()

export const VenuePackageDraftInput = VenuePackagePreviewInput.extend({
  draftKey: z.string().uuid(),
}).strict()

export const VenuePackageByIdInput = z.object({ id: z.string().cuid() }).strict()

export const VenuePackageLifecycleInput = VenuePackageByIdInput.extend({
  expectedUpdatedAt: z.coerce.date(),
  commandKey: z.string().uuid(),
}).strict()

export const VenuePackageApprovalInput = VenuePackageLifecycleInput.extend({
  acknowledgedWarningDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const VenuePackageAppliedEntities = z
  .object({
    postApplyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    places: z.array(
      z
        .object({
          id: z.string().cuid(),
          name: z.string().min(1).max(200),
          type: z.string().min(1),
          itemType: z.string().nullable(),
          shortDescription: z.string().nullable(),
          longDescription: z.string().nullable(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
          tags: z.array(z.string()),
          importanceScore: z.number().int().min(0).max(100),
          areaName: z.string().nullable(),
          hours: z.string().nullable(),
          photoUrl: z.string().nullable(),
        })
        .strict(),
    ),
    knowledgeEntries: z.array(KnowledgeEntryInput.extend({ id: z.string().cuid() }).strict()),
  })
  .strict()

export function canonicalVenuePackagePayload(
  venueId: string,
  payload: z.infer<typeof VenuePackagePayload>,
): string {
  return JSON.stringify([
    'pathfinder:venue-package:canonical-v1',
    payload.schemaVersion,
    canonicalVenueContentImportPayload({
      venueId,
      places: payload.places,
      knowledgeEntries: payload.knowledgeEntries,
    }),
  ])
}

export type VenuePackagePayload = z.infer<typeof VenuePackagePayload>
export type VenuePackageDraftInput = z.infer<typeof VenuePackageDraftInput>
export type VenuePackagePreviewInput = z.infer<typeof VenuePackagePreviewInput>
export type VenuePackageLifecycleInput = z.infer<typeof VenuePackageLifecycleInput>
export type VenuePackageAppliedEntities = z.infer<typeof VenuePackageAppliedEntities>
