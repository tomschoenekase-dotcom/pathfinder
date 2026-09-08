import { z } from 'zod'

/** Fixed input limits for a single bounded guest visit context payload. */
export const GUEST_VISIT_CONTEXT_LIMITS = {
  visitedPlaceIds: 20,
  placeIdLength: 191,
  interests: 5,
  interestLength: 80,
  remainingMinutes: 600,
} as const

const placeId = z
  .string()
  .trim()
  .min(1)
  .max(GUEST_VISIT_CONTEXT_LIMITS.placeIdLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Place IDs must use bounded identifier characters')

/**
 * Explicit visitor-provided context only. Persistence lifetime, reset behavior,
 * expiry, and public/private sharing policy belong to the consuming boundary.
 */
export const GuestVisitContextInput = z
  .object({
    visitedPlaceIds: z
      .array(placeId)
      .max(GUEST_VISIT_CONTEXT_LIMITS.visitedPlaceIds)
      .refine((ids) => new Set(ids).size === ids.length, 'Visited place IDs must be unique')
      .default([]),
    interests: z
      .array(z.string().trim().min(1).max(GUEST_VISIT_CONTEXT_LIMITS.interestLength))
      .max(GUEST_VISIT_CONTEXT_LIMITS.interests)
      .default([]),
    remainingMinutes: z
      .number()
      .int()
      .min(1)
      .max(GUEST_VISIT_CONTEXT_LIMITS.remainingMinutes)
      .nullable()
      .optional(),
  })
  .strict()

export type GuestVisitContextInput = z.infer<typeof GuestVisitContextInput>
