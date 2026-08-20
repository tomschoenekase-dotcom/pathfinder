import {
  ProductCapabilityId,
  ProductEntitlementDecision,
  type ProductCapabilityId as ProductCapabilityIdType,
  type ProductEntitlementDecision as ProductEntitlementDecisionType,
} from '@pathfinder/contracts/product-entitlements'

type JsonRecord = Readonly<Record<string, unknown>>

type EntitlementOverrideRow = {
  id: string
  effect: 'GRANT' | 'DENY'
  settings: unknown
  endsAt: Date | null
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
