import { z } from 'zod'

export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const billingEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RAILWAY_ENVIRONMENT: z.enum(['production', 'staging', 'preview']).default('staging'),
    DASHBOARD_URL: z.string().url(),
    STRIPE_MODE: z.enum(['test', 'live']).default('test'),
    STRIPE_ACCOUNT_NAMESPACE: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u)
      .default('torchiko-test'),
    STRIPE_SECRET_KEY: z.string().trim().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
    STRIPE_CATALOG_JSON: z.string().max(64_000).optional(),
    STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID: z.string().trim().min(1).optional(),
    STRIPE_BILLING_UI_ENABLED: booleanFlag,
    STRIPE_CHECKOUT_ENABLED: booleanFlag,
    STRIPE_CUSTOMER_PORTAL_ENABLED: booleanFlag,
    STRIPE_CANCELLATION_ENABLED: booleanFlag,
    STRIPE_WEBHOOK_PROCESSING_ENABLED: booleanFlag,
    STRIPE_RECONCILIATION_ENABLED: booleanFlag,
    BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED: booleanFlag,
    STRIPE_LIVE_MODE_ALLOWED: booleanFlag,
    TORCHIKO_LEGAL_ENTITY_VERIFIED: booleanFlag,
    TORCHIKO_LEGAL_ENTITY_NAME: z.string().trim().min(1).max(200).optional(),
    BILLING_GRACE_PERIOD_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  })
  .superRefine((value, ctx) => {
    if (value.STRIPE_MODE === 'live') {
      if (value.RAILWAY_ENVIRONMENT !== 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_MODE'],
          message: 'Stripe live mode is forbidden outside the production environment',
        })
      }
      if (!value.STRIPE_LIVE_MODE_ALLOWED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_LIVE_MODE_ALLOWED'],
          message: 'Stripe live mode requires an explicit production kill-switch approval',
        })
      }
      if (!value.TORCHIKO_LEGAL_ENTITY_VERIFIED || !value.TORCHIKO_LEGAL_ENTITY_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TORCHIKO_LEGAL_ENTITY_VERIFIED'],
          message:
            'Stripe live mode requires an owner-verified legal entity name and explicit verification flag',
        })
      }
    }

    if (value.STRIPE_SECRET_KEY) {
      const expectedSuffix = value.STRIPE_MODE === 'live' ? 'live_' : 'test_'
      if (!new RegExp(`^[sr]k_${expectedSuffix}`, 'u').test(value.STRIPE_SECRET_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message: `Stripe ${value.STRIPE_MODE} mode requires a sk_${expectedSuffix} or rk_${expectedSuffix} key`,
        })
      }
    }
  })

export type BillingEnvironment = z.infer<typeof billingEnvironmentSchema>

export function parseBillingEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BillingEnvironment {
  return billingEnvironmentSchema.parse(environment)
}

export type BillingRuntimeCapability =
  | 'ui'
  | 'checkout'
  | 'portal'
  | 'cancellation'
  | 'webhook'
  | 'reconciliation'
  | 'entitlement-enforcement'

export function billingCapabilityEnabled(
  capability: BillingRuntimeCapability,
  environment: BillingEnvironment,
): boolean {
  switch (capability) {
    case 'ui':
      return environment.STRIPE_BILLING_UI_ENABLED
    case 'checkout':
      return environment.STRIPE_CHECKOUT_ENABLED && Boolean(environment.STRIPE_SECRET_KEY)
    case 'portal':
      return (
        environment.STRIPE_CUSTOMER_PORTAL_ENABLED &&
        Boolean(environment.STRIPE_SECRET_KEY) &&
        Boolean(environment.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID)
      )
    case 'cancellation':
      return environment.STRIPE_CANCELLATION_ENABLED && Boolean(environment.STRIPE_SECRET_KEY)
    case 'webhook':
      return (
        environment.STRIPE_WEBHOOK_PROCESSING_ENABLED &&
        Boolean(environment.STRIPE_SECRET_KEY) &&
        Boolean(environment.STRIPE_WEBHOOK_SECRET)
      )
    case 'reconciliation':
      return environment.STRIPE_RECONCILIATION_ENABLED && Boolean(environment.STRIPE_SECRET_KEY)
    case 'entitlement-enforcement':
      return environment.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED
  }
}
