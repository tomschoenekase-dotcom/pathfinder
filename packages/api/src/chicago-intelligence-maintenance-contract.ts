import { z } from 'zod'

const id = z.string().trim().min(1).max(191)
const revision = z.number().int().min(1)
const rationale = z.string().trim().min(12).max(2000)
const mutation = { idempotencyKey: id, venueId: id, expectedVersion: revision, rationale }

export const chicagoLifecycleInput = z.discriminatedUnion('action', [
  z.object({ ...mutation, action: z.literal('archive') }).strict(),
  z.object({ ...mutation, action: z.literal('restore') }).strict(),
  z.object({ ...mutation, action: z.literal('supersede'), supersededByVenueId: id, expectedTargetVersion: revision }).strict(),
])

const override = { ...mutation, expectedRankingVersion: z.string().trim().min(1).max(100) }
export const chicagoRankingOverrideInput = z.discriminatedUnion('mode', [
  z.object({ ...override, mode: z.literal('set'), dimension: z.enum(['productFit', 'attainability', 'contactability']), value: z.number().finite().min(0).max(100) }).strict(),
  z.object({ ...override, mode: z.literal('clear') }).strict(),
])

export const chicagoRankingRefreshInput = z.object({
  idempotencyKey: id, rationale,
  targets: z.array(z.object({ venueId: id, expectedVersion: revision }).strict()).min(1).max(100),
}).strict().superRefine((input, context) => {
  if (new Set(input.targets.map(target => target.venueId)).size !== input.targets.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targets'], message: 'Provide each explicit venue ID only once' })
  }
})
