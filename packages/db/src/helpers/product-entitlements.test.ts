import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ProductEntitlementError,
  requireProductEntitlement,
  resolveProductEntitlement,
  type ProductEntitlementClient,
} from './product-entitlements'

const tenant = vi.fn()
const override = vi.fn()
const plan = vi.fn()
const client = {
  tenant: { findUnique: tenant },
  productEntitlementOverride: { findFirst: override },
  productPlanCapability: { findUnique: plan },
} as ProductEntitlementClient

describe('product entitlement resolution', () => {
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
})
