import { z } from 'zod'

export const OperationalUpdateSeverityInput = z.enum([
  'INFO',
  'WARNING',
  'CLOSURE',
  'REDIRECT',
])

const MIN_EXPIRY_MS = 15 * 60 * 1000
const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export const CreateOperationalUpdateInputBase = z
  .object({
    venueId: z.string().cuid(),
    placeId: z.string().cuid().optional(),
    severity: OperationalUpdateSeverityInput,
    title: z.string().trim().min(1).max(60),
    body: z.string().trim().max(300).optional(),
    redirectTo: z.string().trim().max(200).optional(),
    expiresAt: z.coerce.date(),
  })
  .strict()

export const CreateOperationalUpdateInput = CreateOperationalUpdateInputBase
  .superRefine((input, ctx) => {
    const now = Date.now()
    const expiresAt = input.expiresAt.getTime()

    if (expiresAt < now + MIN_EXPIRY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expiry must be at least 15 minutes from now',
        path: ['expiresAt'],
      })
    }

    if (expiresAt > now + MAX_EXPIRY_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expiry must be within 7 days',
        path: ['expiresAt'],
      })
    }
  })

export const DeactivateOperationalUpdateInput = z
  .object({
    id: z.string().cuid(),
  })
  .strict()
