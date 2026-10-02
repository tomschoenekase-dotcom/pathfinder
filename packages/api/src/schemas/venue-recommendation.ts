import { z } from 'zod'

// Client-safe: no @pathfinder/db import.

export const CatalogCategoryInput = z.enum(['cold_drink', 'hot_drink', 'snack', 'meal', 'other'])
export const CatalogAvailabilityInput = z.enum(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'])
export const CommercialPriorityInput = z.enum(['LOW', 'NORMAL', 'HIGH'])

const text = (max: number) => z.string().trim().min(1).max(max)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Use 24-hour HH:MM')
const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u, 'Use MM-DD')

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** `unknown` is not the same as verified "none": a known list may be empty, an unknown one has no values. */
export const VerifiedListInput = z
  .object({ status: z.enum(['known', 'unknown']), values: z.array(text(80)).max(40) })
  .strict()
  .refine((list) => list.status === 'known' || list.values.length === 0, {
    message: 'An unknown list must not carry values',
  })

export const CatalogHoursInput = z
  .object({
    timeZone: z.string().refine(validTimeZone, 'Unknown IANA time zone'),
    windows: z
      .array(
        z
          .object({
            days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
            open: hhmm,
            close: hhmm,
          })
          .strict()
          .refine((window) => window.close > window.open, {
            message: 'Close must be later than open on the same day',
          }),
      )
      .min(1)
      .max(14),
  })
  .strict()

export const CatalogItemFieldsInput = z
  .object({
    category: CatalogCategoryInput,
    name: text(200),
    description: text(2000).nullable().default(null),
    placeId: z.string().cuid().nullable().default(null),
    routeNote: text(500).nullable().default(null),
    priceMinor: z.number().int().min(0).max(10_000_000).nullable().default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable()
      .default(null),
    sizeLabel: text(64).nullable().default(null),
    priceObservedAt: z.coerce.date().nullable().default(null),
    effectiveFrom: z.coerce.date().nullable().default(null),
    effectiveUntil: z.coerce.date().nullable().default(null),
    availability: CatalogAvailabilityInput.default('UNKNOWN'),
    availabilityObservedAt: z.coerce.date().nullable().default(null),
    hours: CatalogHoursInput.nullable().default(null),
    seasonalWindows: z
      .array(z.object({ start: monthDay, end: monthDay }).strict())
      .max(6)
      .default([]),
    ingredients: VerifiedListInput.default({ status: 'unknown', values: [] }),
    allergens: VerifiedListInput.default({ status: 'unknown', values: [] }),
    dietary: z
      .record(z.string().regex(/^[a-z_]{2,32}$/u), z.enum(['yes', 'no', 'unknown']))
      .default({}),
    sources: z
      .array(
        z
          .object({
            label: text(200),
            url: z.string().url().max(2000).optional(),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    lastVerifiedAt: z.coerce.date().nullable().default(null),
    allowedClaims: z.array(text(200)).max(10).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.priceMinor !== null && (!value.currency || !value.priceObservedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceObservedAt'],
        message: 'A price needs a currency and the date it was observed',
      })
    }
    if (value.availability !== 'UNKNOWN' && !value.availabilityObservedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['availabilityObservedAt'],
        message: 'Availability needs the time it was observed',
      })
    }
    if (
      value.effectiveFrom &&
      value.effectiveUntil &&
      value.effectiveUntil <= value.effectiveFrom
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveUntil'],
        message: 'Effective end must be after the start',
      })
    }
  })

export const VenueRecommendationVenueInput = z.object({ venueId: z.string().cuid() }).strict()

export const UpsertCatalogItemInput = z
  .object({
    venueId: z.string().cuid(),
    /** Present to update; omit to create. */
    itemId: z.string().cuid().optional(),
    /** Required when updating: optimistic concurrency on the item version. */
    expectedVersion: z.number().int().min(1).optional(),
    /** Stable identifier within the venue; fixed at creation. */
    stableKey: z
      .string()
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u)
      .min(2)
      .max(100)
      .optional(),
    fields: CatalogItemFieldsInput,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.itemId === undefined && value.stableKey === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['stableKey'],
        message: 'A new item needs a stable key',
      })
    if (value.itemId !== undefined && value.expectedVersion === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedVersion'],
        message: 'Updating an item needs its current version',
      })
  })

export const ArchiveCatalogItemInput = z
  .object({
    venueId: z.string().cuid(),
    itemId: z.string().cuid(),
    expectedVersion: z.number().int().min(1),
  })
  .strict()

export const SetCatalogItemPriorityInput = z
  .object({
    venueId: z.string().cuid(),
    itemId: z.string().cuid(),
    priority: CommercialPriorityInput,
  })
  .strict()

export const UpsertRecommendationPolicyInput = z
  .object({
    venueId: z.string().cuid(),
    /** Required when a policy already exists. */
    expectedVersion: z.number().int().min(1).optional(),
    enabled: z.boolean(),
    maxBoost: z.number().int().min(0).max(10),
    // PROPOSED test setting: default 1 until the operator confirms a different cap.
    maxUnsolicitedPerSession: z.number().int().min(1).max(3).default(1),
    factMaxAgeDays: z.number().int().min(1).max(365).default(30),
    availabilityMaxAgeHours: z.number().int().min(1).max(168).default(24),
    expiresAt: z.coerce.date().nullable().default(null),
    ownerLabel: text(200),
  })
  .strict()

export const RecommendationMeasurementInput = z
  .object({ venueId: z.string().cuid(), days: z.number().int().min(1).max(90).default(30) })
  .strict()
