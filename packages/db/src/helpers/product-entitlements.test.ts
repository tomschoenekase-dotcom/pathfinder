import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ProductEntitlementError,
  requireProductEntitlement,
  resolveProductEntitlement,
  type ProductEntitlementClient,
} from './product-entitlements'

const tenant = vi.fn()
const override = vi.fn()
const plan = vi.fn()
const billingAccount = vi.fn()
const client = {
  tenant: { findUnique: tenant },
  productEntitlementOverride: { findFirst: override },
  productPlanCapability: { findUnique: plan },
} as ProductEntitlementClient

afterEach(() => vi.unstubAllEnvs())

describe('product entitlement resolution', () => {
  it('does not suspend access from an unapproved default recovery policy', async () => {
    vi.stubEnv('BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED', 'true')
    vi.stubEnv('BILLING_RECOVERY_POLICY_APPROVED', 'false')
    plan.mockResolvedValue({ id: 'launch-widget', enabled: true, settings: {} })
    const decision = await resolveProductEntitlement({
      client: {
        ...client,
        billingAccount: { findUnique: billingAccount },
      } as ProductEntitlementClient,
      tenantId: 'tenant-a',
      capability: 'widget',
    })
    expect(decision).toMatchObject({ enabled: true, source: 'PLAN' })
    expect(billingAccount).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    tenant.mockResolvedValue({ planTier: 'launch' })
    override.mockResolvedValue(null)
    plan.mockResolvedValue(null)
  })

  it('lets the server kill switch deny before grants are considered', async () => {
    const decision = await resolveProductEntitlement({
      client,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      capability: 'voice',
      featureAvailable: false,
    })

    expect(decision).toMatchObject({ enabled: false, source: 'KILL_SWITCH' })
    expect(override).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
  })

  it('applies active venue overrides before tenant and plan configuration', async () => {
    override.mockResolvedValueOnce({
      id: 'venue-grant',
      effect: 'GRANT',
      settings: { tier: 'economy', maxSessionSeconds: 300 },
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    const decision = await resolveProductEntitlement({
      client,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      capability: 'voice',
      now: new Date('2026-08-19T12:00:00.000Z'),
    })

    expect(decision).toMatchObject({
      enabled: true,
      source: 'VENUE_OVERRIDE',
      sourceId: 'venue-grant',
      settings: { tier: 'economy', maxSessionSeconds: 300 },
    })
    expect(override).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a' }),
      }),
    )
    expect(plan).not.toHaveBeenCalled()
  })

  it('lets a tenant denial override a plan grant', async () => {
    override
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'tenant-deny', effect: 'DENY', settings: {}, endsAt: null })
    plan.mockResolvedValue({ id: 'launch-voice', enabled: true, settings: {} })

    await expect(
      resolveProductEntitlement({
        client,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        capability: 'voice',
      }),
    ).resolves.toMatchObject({ enabled: false, source: 'TENANT_OVERRIDE' })
    expect(plan).not.toHaveBeenCalled()
  })

  it('falls back to the plan and denies missing assignments by default', async () => {
    plan.mockResolvedValue({ id: 'launch-widget', enabled: true, settings: { origins: 3 } })
    await expect(
      resolveProductEntitlement({ client, tenantId: 'tenant-a', capability: 'widget' }),
    ).resolves.toMatchObject({ enabled: true, source: 'PLAN' })

    plan.mockResolvedValue(null)
    await expect(
      resolveProductEntitlement({ client, tenantId: 'tenant-a', capability: 'api' }),
    ).resolves.toMatchObject({ enabled: false, source: 'DEFAULT' })
  })

  it('throws a typed denial for guarded capabilities', async () => {
    await expect(
      requireProductEntitlement({ client, tenantId: 'tenant-a', capability: 'voice' }),
    ).rejects.toEqual(new ProductEntitlementError('CAPABILITY_DENIED', 'voice'))
  })

  it.each([undefined, '', '0', '91', '1.5', 'invalid'])(
    'does not suspend access without a valid explicit grace period: %s',
    async (days) => {
      vi.stubEnv('BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED', 'true')
      vi.stubEnv('BILLING_RECOVERY_POLICY_APPROVED', 'true')
      vi.stubEnv('BILLING_GRACE_PERIOD_DAYS', days)
      plan.mockResolvedValue({ id: 'launch-widget', enabled: true, settings: {} })
      await expect(
        resolveProductEntitlement({
          client: {
            ...client,
            billingAccount: { findUnique: billingAccount },
            tenantFeatureFlag: { findUnique: vi.fn().mockResolvedValue({ enabled: true }) },
          },
          tenantId: 'tenant-a',
          capability: 'widget',
        }),
      ).resolves.toMatchObject({ enabled: true, source: 'PLAN' })
      expect(billingAccount).not.toHaveBeenCalled()
    },
  )

  it('enforces the central billing policy only behind the launch kill switch', async () => {
    vi.stubEnv('BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED', 'true')
    vi.stubEnv('BILLING_RECOVERY_POLICY_APPROVED', 'true')
    vi.stubEnv('BILLING_GRACE_PERIOD_DAYS', '14')
    const enforcingClient = {
      ...client,
      billingAccount: { findUnique: billingAccount },
      tenantFeatureFlag: { findUnique: vi.fn().mockResolvedValue({ enabled: true }) },
    }
    billingAccount.mockResolvedValue({
      id: 'billing-a',
      status: 'PAST_DUE',
      paidThroughAt: null,
      gracePeriodEndsAt: new Date('2026-08-18T00:00:00.000Z'),
      commercialAgreements: [
        {
          id: 'agreement-a',
          billingMode: 'STRIPE_SUBSCRIPTION',
          status: 'PAST_DUE',
          stripeSubscriptionStatus: 'PAST_DUE',
          currentPeriodEndsAt: null,
          accessStartsAt: null,
          accessEndsAt: null,
          cancelAtPeriodEnd: false,
        },
      ],
      accessOverrides: [],
    })
    await expect(
      resolveProductEntitlement({
        client: enforcingClient,
        tenantId: 'tenant-a',
        capability: 'widget',
        now: new Date('2026-08-20T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      enabled: false,
      source: 'BILLING_POLICY',
      settings: { accessState: 'SUSPENDED' },
    })
    expect(override).not.toHaveBeenCalled()
    expect(plan).not.toHaveBeenCalled()
  })
})
