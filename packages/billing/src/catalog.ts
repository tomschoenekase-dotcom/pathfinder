import { z } from 'zod'

export const BillingPlan = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u),
    version: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    providerMode: z.enum(['test', 'live']),
    stripeProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/u),
    stripePriceId: z.string().regex(/^price_[A-Za-z0-9]+$/u),
    currency: z.string().regex(/^[a-z]{3}$/u),
    interval: z.enum(['month', 'year']),
    intervalCount: z.number().int().positive().max(12).default(1),
    unitAmount: z.number().int().nonnegative(),
    minimumVenueCount: z.number().int().positive().default(1),
    maximumVenueCount: z.number().int().positive().nullable().default(null),
    newSalesEnabled: z.boolean().default(false),
    portalChangesEnabled: z.boolean().default(false),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine(
    (value) =>
      value.maximumVenueCount === null || value.maximumVenueCount >= value.minimumVenueCount,
    { message: 'maximumVenueCount must be greater than or equal to minimumVenueCount' },
  )

export type BillingPlan = z.infer<typeof BillingPlan>

const BillingCatalog = z
  .object({
    catalogVersion: z.number().int().positive(),
    plans: z.array(BillingPlan).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>()
    const providerIds = new Set<string>()
    value.plans.forEach((plan, index) => {
      if (plan.providerMode === 'live' && /(?:^|[-_])test(?:$|[-_])/u.test(plan.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plans', index, 'key'],
          message: 'Test fixture plan keys are forbidden in the live catalog',
        })
      }
      const key = `${plan.key}@${plan.version}:${plan.providerMode}`
      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plans', index],
          message: `Duplicate ${key}`,
        })
      }
      keys.add(key)
      const providerId = `${plan.providerMode}:${plan.stripePriceId}`
      if (providerIds.has(providerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plans', index, 'stripePriceId'],
          message: `Duplicate provider price ${providerId}`,
        })
      }
      providerIds.add(providerId)
    })
  })

export type BillingCatalog = z.infer<typeof BillingCatalog>

export function parseBillingCatalog(serialized: string | undefined): BillingCatalog {
  if (!serialized) return { catalogVersion: 1, plans: [] }
  return BillingCatalog.parse(JSON.parse(serialized) as unknown)
}

export function findApprovedPlan(params: {
  catalog: BillingCatalog
  key: string
  version?: number
  providerMode: 'test' | 'live'
  venueCount: number
  forNewSale?: boolean
}): BillingPlan {
  const candidates = params.catalog.plans
    .filter((plan) => plan.key === params.key && plan.providerMode === params.providerMode)
    .filter((plan) => params.version === undefined || plan.version === params.version)
    .filter((plan) => !params.forNewSale || plan.newSalesEnabled)
    .filter(
      (plan) =>
        params.venueCount >= plan.minimumVenueCount &&
        (plan.maximumVenueCount === null || params.venueCount <= plan.maximumVenueCount),
    )
    .sort((left, right) => right.version - left.version)
  const plan = candidates[0]
  if (!plan) throw new BillingCatalogError('PLAN_NOT_AVAILABLE')
  return plan
}

export class BillingCatalogError extends Error {
  constructor(readonly code: 'PLAN_NOT_AVAILABLE') {
    super('The requested billing plan is not available for this operation')
    this.name = 'BillingCatalogError'
  }
}
