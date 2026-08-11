import { z } from 'zod'

const nonEmptyText = z.string().trim().min(1)
const webHref = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  }, 'Only HTTP and HTTPS links are supported')

export const GuestResponsePlace = z.object({
  id: nonEmptyText,
  name: nonEmptyText,
  type: nonEmptyText,
  photoUrl: webHref.nullable(),
  shortDescription: z.string().nullable(),
  areaName: z.string().nullable(),
  hours: z.string().nullable(),
  distanceMeters: z.number().finite().nonnegative().optional(),
  lat: z.number().finite().min(-90).max(90).nullable(),
  lng: z.number().finite().min(-180).max(180).nullable(),
})

export const GuestResponseTextBlock = z.object({
  type: z.literal('text'),
  text: nonEmptyText,
})

export const GuestResponseCalloutBlock = z.object({
  type: z.literal('callout'),
  tone: z.enum(['info', 'success', 'warning']).default('info'),
  title: nonEmptyText.optional(),
  text: nonEmptyText,
})

export const GuestResponseActionsBlock = z.object({
  type: z.literal('actions'),
  actions: z
    .array(
      z.object({
        label: nonEmptyText,
        href: webHref,
        style: z.enum(['primary', 'secondary']).default('secondary'),
      }),
    )
    .min(1)
    .max(6),
})

export const GuestResponseCitationsBlock = z.object({
  type: z.literal('citations'),
  citations: z
    .array(
      z.object({
        label: nonEmptyText,
        href: webHref.optional(),
        detail: nonEmptyText.optional(),
      }),
    )
    .min(1)
    .max(12),
})

export const GuestResponsePlacesBlock = z.object({
  type: z.literal('places'),
  places: z.array(GuestResponsePlace).min(1).max(12),
})

export const GuestResponseBlock = z.discriminatedUnion('type', [
  GuestResponseTextBlock,
  GuestResponseCalloutBlock,
  GuestResponseActionsBlock,
  GuestResponseCitationsBlock,
  GuestResponsePlacesBlock,
])

/**
 * Browser-safe structured guest response envelope. Versioning lets the public
 * client reject future incompatible payloads instead of guessing their shape.
 */
export const GuestStructuredResponse = z.object({
  version: z.literal(1),
  blocks: z.array(GuestResponseBlock).min(1).max(24),
})

export type GuestResponsePlace = z.infer<typeof GuestResponsePlace>
export type GuestResponseBlock = z.infer<typeof GuestResponseBlock>
export type GuestStructuredResponse = z.infer<typeof GuestStructuredResponse>
