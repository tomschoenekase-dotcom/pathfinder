import {
  ProductCapabilityId,
  ProductEntitlementDecision,
  type ProductCapabilityId as ProductCapabilityIdType,
  type ProductEntitlementDecision as ProductEntitlementDecisionType,
} from '@pathfinder/contracts/product-entitlements'
import { evaluateBillingAccess } from '@pathfinder/contracts/billing-access-policy'

type JsonRecord = Readonly<Record<string, unknown>>

type EntitlementOverrideRow = {
  id: string
  effect: 'GRANT' | 'DENY'
  settings: unknown
  endsAt: Date | null
}

type BillingPolicyAccountRow = {
  id: string
  status: string
  paidThroughAt: Date | null
  gracePeriodEndsAt: Date | null
  commercialAgreements: Array<{
    id: string
    billingMode:
      | 'STRIPE_SUBSCRIPTION'
      | 'STRIPE_INVOICE'
      | 'MANUAL_INVOICE'
      | 'COMPLIMENTARY'
      | 'PILOT'
      | 'NO_BILLING_REQUIRED'
    status:
      | 'DRAFT'
      | 'PENDING'
      | 'TRIALING'
      | 'ACTIVE'
      | 'PAST_DUE'
      | 'UNPAID'
      | 'CANCELED'
      | 'ENDED'
      | 'PAUSED'
      | 'MANUAL_REVIEW'
    stripeSubscriptionStatus: string | null
    currentPeriodEndsAt: Date | null
    accessStartsAt: Date | null
    accessEndsAt: Date | null
    cancelAtPeriodEnd: boolean
  }>
  accessOverrides: Array<{ id: string; effect: 'GRANT' | 'DENY'; reason: string; expiresAt: Date }>
}

export type ProductEntitlementClient = {
  tenant: {
    findUnique: (args: {
      where: { id: string }
      select: { planTier: true }
    }) => Promise<{ planTier: string } | null>
  }
  productEntitlementOverride: {
    findFirst: (args: {
      where: {
        tenantId: string
        venueId: string | null
        capability: ProductCapabilityIdType
        startsAt: { lte: Date }
        OR: [{ endsAt: null }, { endsAt: { gt: Date } }]
      }
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      select: { id: true; effect: true; settings: true; endsAt: true }
    }) => Promise<EntitlementOverrideRow | null>
  }
  productPlanCapability: {
    findUnique: (args: {
      where: { planTier_capability: { planTier: string; capability: ProductCapabilityIdType } }
      select: { id: true; enabled: true; settings: true }
    }) => Promise<{ id: string; enabled: boolean; settings: unknown } | null>
  }
  billingAccount?: {
    findUnique: (args: {
      where: { tenantId: string }
      select: {
        id: true
        status: true
        paidThroughAt: true
        gracePeriodEndsAt: true
        commercialAgreements: {
          where: { tenantId: string; isBase: true }
          orderBy: { createdAt: 'desc' }
          take: 1
          select: {
            id: true
            billingMode: true
            status: true
            stripeSubscriptionStatus: true
            currentPeriodEndsAt: true
            accessStartsAt: true
            accessEndsAt: true
            cancelAtPeriodEnd: true
          }
        }
        accessOverrides: {
          where: {
            tenantId: string
            startsAt: { lte: Date }
            expiresAt: { gt: Date }
            OR: Array<Record<string, unknown>>
          }
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
          take: 1
          select: { id: true; effect: true; reason: true; expiresAt: true }
        }
      }
    }) => Promise<BillingPolicyAccountRow | null>
  }
  tenantFeatureFlag?: {
    findUnique: (args: {
      where: { tenantId_flagKey: { tenantId: string; flagKey: string } }
      select: { enabled: true }
    }) => Promise<{ enabled: boolean } | null>
  }
}

function settingsRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function findActiveOverride(params: {
  client: ProductEntitlementClient
  tenantId: string
  venueId: string | null
  capability: ProductCapabilityIdType
  now: Date
}): Promise<EntitlementOverrideRow | null> {
  return params.client.productEntitlementOverride.findFirst({
    where: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      capability: params.capability,
      startsAt: { lte: params.now },
      OR: [{ endsAt: null }, { endsAt: { gt: params.now } }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, effect: true, settings: true, endsAt: true },
  })
}

/**
 * Resolves one product capability without coupling it to billing. Server kill
 * switches always win, followed by active venue and tenant overrides, then the
 * platform-owned plan assignment. Missing configuration is denied by default.
 */
export async function resolveProductEntitlement(params: {
  client: ProductEntitlementClient
  tenantId: string
  venueId?: string
  capability: ProductCapabilityIdType
  featureAvailable?: boolean
  now?: Date
}): Promise<ProductEntitlementDecisionType> {
  const capability = ProductCapabilityId.parse(params.capability)
  const now = params.now ?? new Date()
  const tenant = await params.client.tenant.findUnique({
    where: { id: params.tenantId },
    select: { planTier: true },
  })
  if (!tenant) throw new ProductEntitlementError('TENANT_NOT_FOUND', capability)

  if (params.featureAvailable === false) {
    return ProductEntitlementDecision.parse({
      capability,
      enabled: false,
      source: 'KILL_SWITCH',
      sourceId: null,
      planTier: tenant.planTier,
      settings: {},
      validUntil: null,
    })
  }

  if (process.env.BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED === 'true') {
    const tenantEnforcement = await params.client.tenantFeatureFlag?.findUnique({
      where: {
        tenantId_flagKey: {
          tenantId: params.tenantId,
          flagKey: 'billing-entitlement-enforcement-v1',
        },
      },
      select: { enabled: true },
    })
    if (tenantEnforcement?.enabled) {
      const billingAccount = await params.client.billingAccount?.findUnique({
        where: { tenantId: params.tenantId },
        select: {
          id: true,
          status: true,
          paidThroughAt: true,
          gracePeriodEndsAt: true,
          commercialAgreements: {
            where: { tenantId: params.tenantId, isBase: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              billingMode: true,
              status: true,
              stripeSubscriptionStatus: true,
              currentPeriodEndsAt: true,
              accessStartsAt: true,
              accessEndsAt: true,
              cancelAtPeriodEnd: true,
            },
          },
          accessOverrides: {
            where: {
              tenantId: params.tenantId,
              startsAt: { lte: now },
              expiresAt: { gt: now },
              OR: [
                { venueId: null, capability: null },
                { venueId: params.venueId ?? null, capability: null },
                { venueId: null, capability },
                { venueId: params.venueId ?? null, capability },
              ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { id: true, effect: true, reason: true, expiresAt: true },
          },
        },
      })
      const agreement = billingAccount?.commercialAgreements[0]
      const billingOverride = billingAccount?.accessOverrides[0]
      const decision = agreement
        ? evaluateBillingAccess({
            billingMode: agreement.billingMode,
            arrangementStatus: agreement.status,
            providerSubscriptionStatus: (agreement.stripeSubscriptionStatus ?? null) as Exclude<
              Parameters<typeof evaluateBillingAccess>[0]['providerSubscriptionStatus'],
              undefined
            >,
            paidThrough: billingAccount.paidThroughAt ?? agreement.currentPeriodEndsAt,
            accessStartsAt: agreement.accessStartsAt,
            accessEndsAt: agreement.accessEndsAt,
            graceEndsAt: billingAccount.gracePeriodEndsAt,
            cancelAtPeriodEnd: agreement.cancelAtPeriodEnd,
            disputeOpen: billingAccount.status === 'MANUAL_REVIEW',
            override: billingOverride
              ? {
                  reason: billingOverride.reason,
                  expiresAt: billingOverride.expiresAt,
                  grantsAccess: billingOverride.effect === 'GRANT',
                }
              : null,
            now,
          })
        : null
      if (!decision?.entitlementsActive) {
        return ProductEntitlementDecision.parse({
          capability,
          enabled: false,
          source: 'BILLING_POLICY',
          sourceId: agreement?.id ?? billingAccount?.id ?? null,
          planTier: tenant.planTier,
          settings: { accessState: decision?.state ?? 'UNCONFIGURED' },
          validUntil: decision?.validUntil?.toISOString() ?? null,
        })
      }
    }
  }

  if (params.venueId) {
    const override = await findActiveOverride({
      client: params.client,
      tenantId: params.tenantId,
      venueId: params.venueId,
      capability,
      now,
    })
    if (override) {
      return ProductEntitlementDecision.parse({
        capability,
        enabled: override.effect === 'GRANT',
        source: 'VENUE_OVERRIDE',
        sourceId: override.id,
        planTier: tenant.planTier,
        settings: settingsRecord(override.settings),
        validUntil: override.endsAt?.toISOString() ?? null,
      })
    }
  }

  const tenantOverride = await findActiveOverride({
    client: params.client,
    tenantId: params.tenantId,
    venueId: null,
    capability,
    now,
  })
  if (tenantOverride) {
    return ProductEntitlementDecision.parse({
      capability,
      enabled: tenantOverride.effect === 'GRANT',
      source: 'TENANT_OVERRIDE',
      sourceId: tenantOverride.id,
      planTier: tenant.planTier,
      settings: settingsRecord(tenantOverride.settings),
      validUntil: tenantOverride.endsAt?.toISOString() ?? null,
    })
  }

  const plan = await params.client.productPlanCapability.findUnique({
    where: { planTier_capability: { planTier: tenant.planTier, capability } },
    select: { id: true, enabled: true, settings: true },
  })
  return ProductEntitlementDecision.parse({
    capability,
    enabled: plan?.enabled ?? false,
    source: plan ? 'PLAN' : 'DEFAULT',
    sourceId: plan?.id ?? null,
    planTier: tenant.planTier,
    settings: settingsRecord(plan?.settings),
    validUntil: null,
  })
}

export class ProductEntitlementError extends Error {
  constructor(
    readonly code: 'TENANT_NOT_FOUND' | 'CAPABILITY_DENIED',
    readonly capability: ProductCapabilityIdType,
  ) {
    super(
      code === 'TENANT_NOT_FOUND'
        ? 'The entitlement tenant does not exist'
        : `Product capability ${capability} is not enabled`,
    )
    this.name = 'ProductEntitlementError'
  }
}

export async function requireProductEntitlement(
  params: Parameters<typeof resolveProductEntitlement>[0],
): Promise<ProductEntitlementDecisionType> {
  const decision = await resolveProductEntitlement(params)
  if (!decision.enabled) throw new ProductEntitlementError('CAPABILITY_DENIED', decision.capability)
  return decision
}
