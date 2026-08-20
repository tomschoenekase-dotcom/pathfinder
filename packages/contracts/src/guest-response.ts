import { z } from 'zod'

const nonEmptyText = z.string().trim().min(1)
const shortText = nonEmptyText.max(120)
const webHref = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  }, 'Only HTTP and HTTPS links are supported')

const sensitiveUrlKey =
  /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu
const safeHttpsHref = z
  .string()
  .trim()
  .max(2_000)
  .url()
  .refine((value) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(
      (key) => sensitiveUrlKey.test(key),
    )
  }, 'Link must use HTTPS and contain no credentials or secret-like parameters')

const isoDateTime = z.string().datetime({ offset: true })

export const GuestPublicErrorCode = z.enum([
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'OUTCOME_AMBIGUOUS',
  'CONTENT_UNAVAILABLE',
  'REJECTED',
  'TRANSIENT_FAILURE',
])

export type GuestPublicErrorCode = z.infer<typeof GuestPublicErrorCode>

export const GuestResponsePlace = z
  .object({
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
  .strict()

export const GuestResponseTextBlock = z
  .object({
    type: z.literal('text'),
    text: nonEmptyText,
  })
  .strict()

export const GuestResponseCalloutBlock = z
  .object({
    type: z.literal('callout'),
    tone: z.enum(['info', 'success', 'warning']).default('info'),
    title: nonEmptyText.optional(),
    text: nonEmptyText,
  })
  .strict()

export const GuestVisitorActionType = z.enum([
  'NAVIGATE',
  'SHOW_ON_MAP',
  'CALL',
  'OPEN_WEBSITE',
  'BUY_TICKETS',
  'LEARN_MORE',
  'ASK_STAFF',
  'OPEN_EXHIBIT',
  'START_DIRECTIONS',
  'VIEW_ACCESSIBILITY_INFO',
])

const GuestVisitorActionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('URL'), url: safeHttpsHref }).strict(),
  z
    .object({
      kind: z.literal('PHONE'),
      phone: z
        .string()
        .trim()
        .regex(/^\+[1-9][0-9]{6,14}$/u),
    })
    .strict(),
  z.object({ kind: z.literal('LOCATION_ID'), locationId: nonEmptyText.max(191) }).strict(),
  z.object({ kind: z.literal('PLACE_ID'), placeId: nonEmptyText.max(191) }).strict(),
  z.object({ kind: z.literal('STAFF') }).strict(),
])

export const GuestVisitorAction = z
  .object({
    type: GuestVisitorActionType,
    label: nonEmptyText.max(120),
    target: GuestVisitorActionTarget,
    style: z.enum(['primary', 'secondary']).default('secondary'),
    icon: z
      .enum([
        'map',
        'directions',
        'phone',
        'external-link',
        'ticket',
        'info',
        'staff',
        'accessibility',
      ])
      .optional(),
    analyticsKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    permissionRequirement: z
      .enum(['PUBLIC', 'AUTHENTICATED', 'EMPLOYEE', 'ADMIN'])
      .default('PUBLIC'),
    confirmationRequired: z.boolean().default(false),
    fallbackUrl: safeHttpsHref.optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const targetKind = action.target.kind
    const allowed =
      (action.type === 'CALL' && targetKind === 'PHONE') ||
      (['NAVIGATE', 'SHOW_ON_MAP', 'START_DIRECTIONS'].includes(action.type) &&
        (targetKind === 'LOCATION_ID' || targetKind === 'PLACE_ID')) ||
      (action.type === 'ASK_STAFF' && targetKind === 'STAFF') ||
      ([
        'OPEN_WEBSITE',
        'BUY_TICKETS',
        'LEARN_MORE',
        'OPEN_EXHIBIT',
        'VIEW_ACCESSIBILITY_INFO',
      ].includes(action.type) &&
        (targetKind === 'URL' || targetKind === 'PLACE_ID' || targetKind === 'LOCATION_ID'))
    if (!allowed)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: 'Action target is not valid for this action type',
      })
  })

const LegacyGuestVisitorAction = z
  .object({
    label: nonEmptyText,
    href: webHref,
    style: z.enum(['primary', 'secondary']).default('secondary'),
  })
  .strict()

export const GuestResponseActionsBlock = z
  .object({
    type: z.literal('actions'),
    actions: z
      .array(z.union([GuestVisitorAction, LegacyGuestVisitorAction]))
      .min(1)
      .max(6),
  })
  .strict()

export const GuestResponseCitationsBlock = z
  .object({
    type: z.literal('citations'),
    citations: z
      .array(
        z
          .object({
            label: nonEmptyText,
            href: webHref.optional(),
            detail: nonEmptyText.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()

export const GuestResponsePlacesBlock = z
  .object({
    type: z.literal('places'),
    places: z.array(GuestResponsePlace).min(1).max(12),
  })
  .strict()

export const GuestResponseChoicesBlock = z
  .object({
    type: z.literal('choices'),
    label: shortText,
    choices: z
      .array(
        z
          .object({
            id: nonEmptyText.max(80),
            label: nonEmptyText.max(80),
            value: nonEmptyText.max(200),
            accessibleLabel: shortText.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict()

export const GuestResponseImage = z
  .object({
    src: safeHttpsHref,
    alt: nonEmptyText.max(240),
    caption: z.string().trim().max(300).optional(),
    width: z.number().int().min(1).max(8_192).optional(),
    height: z.number().int().min(1).max(8_192).optional(),
  })
  .strict()

export const GuestResponseImageBlock = z
  .object({
    type: z.literal('image'),
    image: GuestResponseImage,
  })
  .strict()

export const GuestResponseGalleryBlock = z
  .object({
    type: z.literal('gallery'),
    label: shortText,
    images: z.array(GuestResponseImage).min(1).max(8),
  })
  .strict()

export const GuestResponseEvent = z
  .object({
    id: nonEmptyText.max(80),
    title: nonEmptyText.max(160),
    description: z.string().trim().max(500).optional(),
    startsAt: isoDateTime,
    endsAt: isoDateTime.optional(),
    timezone: nonEmptyText.max(80).optional(),
    location: nonEmptyText.max(160).optional(),
    href: safeHttpsHref.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.endsAt && Date.parse(event.endsAt) <= Date.parse(event.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Event end must be after its start',
      })
    }
  })

export const GuestResponseEventsBlock = z
  .object({
    type: z.literal('events'),
    label: shortText,
    events: z.array(GuestResponseEvent).min(1).max(8),
  })
  .strict()

export const GuestResponseLocationBlock = z
  .object({
    type: z.literal('location'),
    name: nonEmptyText.max(160),
    address: z.string().trim().max(300).optional(),
    detail: z.string().trim().max(300).optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    mapHref: safeHttpsHref,
  })
  .strict()
  .superRefine((location, ctx) => {
    if ((location.latitude === undefined) !== (location.longitude === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latitude'],
        message: 'Latitude and longitude must be supplied together',
      })
    }
  })

export const GuestResponseBlock = z.union([
  GuestResponseTextBlock,
  GuestResponseCalloutBlock,
  GuestResponseActionsBlock,
  GuestResponseCitationsBlock,
  GuestResponsePlacesBlock,
  GuestResponseChoicesBlock,
  GuestResponseImageBlock,
  GuestResponseGalleryBlock,
  GuestResponseEventsBlock,
  GuestResponseLocationBlock,
])

/**
 * Browser-safe structured guest response envelope. Versioning lets the public
 * client reject future incompatible payloads instead of guessing their shape.
 */
export const GuestStructuredResponse = z
  .object({
    version: z.literal(1),
    blocks: z.array(GuestResponseBlock).min(1).max(24),
  })
  .strict()

export type GuestResponsePlace = z.infer<typeof GuestResponsePlace>
export type GuestVisitorAction = z.infer<typeof GuestVisitorAction>
export type GuestResponseBlock = z.infer<typeof GuestResponseBlock>
export type GuestStructuredResponse = z.infer<typeof GuestStructuredResponse>

export function legacyGuestResponseToBlocks(input: {
  content: string
  places?: GuestResponsePlace[]
}): GuestResponseBlock[] {
  return [
    ...(input.content.trim() ? [{ type: 'text' as const, text: input.content }] : []),
    ...(input.places?.length ? [{ type: 'places' as const, places: input.places }] : []),
  ]
}
