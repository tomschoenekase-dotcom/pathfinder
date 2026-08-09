import { z } from 'zod'

export const VENUE_PACKAGE_SCHEMA_VERSION_V1 = 1 as const
export const VENUE_PACKAGE_ITEM_LIMIT = 500
export const MEDIA_SOURCE_FILENAME_LIMIT = 1_000

const ItemTypeInput = z
  .union([
    z.enum([
      'physical_place',
      'exhibit',
      'room',
      'sculpture',
      'service_step',
      'faq',
      'amenity',
      'policy',
      'activity',
      'general_info',
    ]),
    z.literal(''),
  ])
  .optional()
  .transform((value) => (value === '' ? undefined : value))

export const PlaceInput = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1),
    itemType: ItemTypeInput,
    shortDescription: z.string().max(500).optional(),
    longDescription: z.string().max(2000).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    tags: z.array(z.string()).default([]),
    importanceScore: z.number().int().min(0).max(100).default(0),
    areaName: z.string().max(200).optional(),
    hours: z.string().max(200).optional(),
    photoUrl: z
      .union([z.string().url().max(2000), z.literal('')])
      .optional()
      .transform((value) => (value === '' ? undefined : value)),
  })
  .strict()

export const KnowledgeEntryInput = z
  .object({
    title: z.string().min(1).max(200),
    category: z.string().min(1).max(100),
    content: z.string().min(1).max(5000),
    isEnabled: z.boolean().default(true),
  })
  .strict()

export const VenuePackagePayloadV1Object = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V1),
    places: z.array(PlaceInput).max(VENUE_PACKAGE_ITEM_LIMIT),
    knowledgeEntries: z.array(KnowledgeEntryInput).max(VENUE_PACKAGE_ITEM_LIMIT),
  })
  .strict()

export const VenuePackagePayloadV1 = VenuePackagePayloadV1Object.superRefine((payload, context) => {
  const itemCount = payload.places.length + payload.knowledgeEntries.length
  if (itemCount === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Include at least one guide item or knowledge entry',
    })
  }
  if (itemCount > VENUE_PACKAGE_ITEM_LIMIT) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: VENUE_PACKAGE_ITEM_LIMIT,
      type: 'array',
      inclusive: true,
      message: `A venue package can contain at most ${VENUE_PACKAGE_ITEM_LIMIT} total items`,
    })
  }
  payload.places.forEach((place, index) => {
    if ((place.lat === undefined) !== (place.lng === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['places', index],
        message: 'Latitude and longitude must be supplied together',
      })
    }
  })
})

export type VenuePackagePayloadV1 = z.infer<typeof VenuePackagePayloadV1>
