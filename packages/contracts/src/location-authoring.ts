import { z } from 'zod'

export const VenueLocationKindSchema = z.enum([
  'VENUE',
  'FLOOR',
  'ZONE',
  'ROOM',
  'POI',
  'ENTRANCE',
  'EXIT',
  'RESTROOM',
  'EXHIBIT',
  'ACCESSIBILITY_POINT',
  'SERVICE_DESK',
  'FOOD',
  'PARKING',
])

export const VenueLocationStableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use lowercase letters, numbers, and hyphens.')

export const PublicMapReferenceSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
    const secretPattern =
      /token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-/iu
    return !keys.some((key) => secretPattern.test(key)) && !secretPattern.test(url.hash)
  }, 'Use a public HTTPS URL without credentials or secret-like parameters.')

export const VenueLocationDraftFieldsSchema = z
  .object({
    stableKey: VenueLocationStableKeySchema,
    kind: VenueLocationKindSchema,
    displayName: z.string().trim().min(1).max(191),
    description: z.string().trim().max(2000).nullable().default(null),
    visibility: z.enum(['PUBLIC', 'SECOND_LAYER']).default('PUBLIC'),
    floorId: z.string().uuid().nullable().default(null),
    parentLocationId: z.string().uuid().nullable().default(null),
    coordinates: z
      .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
      .strict()
      .nullable()
      .default(null),
    mapAnchor: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .nullable()
      .default(null),
    externalMapReference: z.union([PublicMapReferenceSchema, z.null()]).default(null),
    accessibilityMetadata: z
      .record(z.string().min(1).max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
      .superRefine((value, context) => {
        if (Object.keys(value).length > 20) {
          context.addIssue({
            code: 'custom',
            message: 'At most 20 accessibility facts are allowed.',
          })
        }
        if (JSON.stringify(value).length > 5000) {
          context.addIssue({ code: 'custom', message: 'Accessibility facts are too large.' })
        }
      })
      .default({}),
  })
  .strict()

export type VenueLocationDraftFields = z.infer<typeof VenueLocationDraftFieldsSchema>

export const LocationDraftProposalSnapshotSchema = z
  .object({
    contractVersion: z.literal(1),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    draft: VenueLocationDraftFieldsSchema,
    canonicalVenueContentChanged: z.literal(false),
  })
  .strict()
