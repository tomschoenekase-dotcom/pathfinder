import { z } from 'zod'

export const MAX_GUEST_OPERATIONAL_UPDATES = 20

export const OperationalUpdateSeverityInput = z.enum(['INFO', 'WARNING', 'CLOSURE', 'REDIRECT'])
export const OperationalUpdatePriorityInput = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export const OperationalUpdateStatusInput = z.enum(['DRAFT', 'PUBLISHED'])
export const OperationalUpdateTypeInput = z.enum([
  'GENERAL_NOTICE',
  'TEMPORARY_CLOSURE',
  'UNAVAILABLE_EXHIBIT',
  'CHANGED_HOURS',
  'MAINTENANCE',
  'SPECIAL_EVENT',
  'SOLD_OUT_ACTIVITY',
  'TEMPORARY_VENDOR_LOCATION',
])

const redirectToInput = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => {
      if (value.startsWith('/')) return true
      try {
        new URL(value)
        return true
      } catch {
        return false
      }
    },
    { message: 'Redirect must be a valid URL or a relative path starting with /' },
  )

export const OperationalUpdateFieldsInput = z
  .object({
    venueId: z.string().cuid(),
    placeId: z.string().cuid().nullable().optional(),
    updateType: OperationalUpdateTypeInput,
    severity: OperationalUpdateSeverityInput,
    priority: OperationalUpdatePriorityInput,
    title: z.string().trim().min(1).max(60),
    body: z.string().trim().max(300).nullable().optional(),
    redirectTo: redirectToInput.nullable().optional(),
    startsAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
  })
  .strict()

function validateWindow(input: { startsAt: Date; expiresAt: Date }, ctx: z.RefinementCtx): void {
  if (input.startsAt.getTime() >= input.expiresAt.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expiry must be after the start time',
      path: ['expiresAt'],
    })
  }
}

export const CreateOperationalUpdateInputBase = OperationalUpdateFieldsInput
export const CreateOperationalUpdateInput = OperationalUpdateFieldsInput.extend({
  publish: z.boolean().default(false),
}).superRefine(validateWindow)

export const UpdateOperationalUpdateInput = OperationalUpdateFieldsInput.extend({
  id: z.string().cuid(),
  expectedUpdatedAt: z.coerce.date(),
  publish: z.boolean().default(false),
}).superRefine(validateWindow)

export const OperationalUpdateLifecycleInput = z
  .object({
    id: z.string().cuid(),
    expectedUpdatedAt: z.coerce.date(),
  })
  .strict()

export const DeactivateOperationalUpdateInput = OperationalUpdateLifecycleInput
