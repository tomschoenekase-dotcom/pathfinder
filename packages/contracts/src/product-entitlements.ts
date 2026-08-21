import { z } from 'zod'

export const PRODUCT_CAPABILITY_IDS = [
  'voice',
  'premium-voice',
  'advanced-model',
  'premium-conversation',
  'employee-mode',
  'analytics-plus',
  'custom-bot',
  'branded-bot',
  'custom-domain',
  'widget',
  'api',
  'location-plus',
  'advanced-actions',
  'knowledge-automation',
  'multi-venue',
  'support-priority',
] as const

export const ProductCapabilityId = z.enum(PRODUCT_CAPABILITY_IDS)
export type ProductCapabilityId = z.infer<typeof ProductCapabilityId>

export const PRODUCT_CAPABILITY_REGISTRY = Object.freeze({
  voice: { label: 'Voice', experimental: true },
  'premium-voice': { label: 'Premium voice', experimental: true },
  'advanced-model': { label: 'Advanced model', experimental: true },
  'premium-conversation': { label: 'Premium conversation', experimental: true },
  'employee-mode': { label: 'Employee assistant', experimental: true },
  'analytics-plus': { label: 'Advanced analytics', experimental: true },
  'custom-bot': { label: 'Custom bot', experimental: false },
  'branded-bot': { label: 'Branded bot', experimental: false },
  'custom-domain': { label: 'Custom domain', experimental: false },
  widget: { label: 'Embeddable widget', experimental: true },
  api: { label: 'API access', experimental: true },
  'location-plus': { label: 'Location intelligence', experimental: true },
  'advanced-actions': { label: 'Advanced visitor actions', experimental: true },
  'knowledge-automation': { label: 'Knowledge automation', experimental: true },
  'multi-venue': { label: 'Multiple venues', experimental: false },
  'support-priority': { label: 'Priority support', experimental: false },
} as const satisfies Readonly<
  Record<ProductCapabilityId, Readonly<{ label: string; experimental: boolean }>>
>)

export const ProductEntitlementDecision = z
  .object({
    capability: ProductCapabilityId,
    enabled: z.boolean(),
    source: z.enum([
      'KILL_SWITCH',
      'BILLING_POLICY',
      'VENUE_OVERRIDE',
      'TENANT_OVERRIDE',
      'PLAN',
      'DEFAULT',
    ]),
    sourceId: z.string().min(1).nullable(),
    planTier: z.string().min(1),
    settings: z.record(z.unknown()),
    validUntil: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()

export type ProductEntitlementDecision = z.infer<typeof ProductEntitlementDecision>
