import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  flagFindMany: vi.fn(),
  flagFindUnique: vi.fn(),
  flagUpsert: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  setActor: vi.fn(),
}))

const transactionClient = {
  tenant: { findUnique: mocks.tenantFindUnique },
  tenantFeatureFlag: { findUnique: mocks.flagFindUnique, upsert: mocks.flagUpsert },
  auditLog: { create: mocks.auditCreate },
}

vi.mock('@pathfinder/config', () => ({
  BILLING_TENANT_FLAG_KEYS: {
    ui: 'billing-ui-v1',
    checkout: 'billing-checkout-v1',
    portal: 'billing-portal-v1',
    cancellation: 'billing-cancellation-v1',
    entitlementEnforcement: 'billing-entitlement-enforcement-v1',
  },
  isFeatureEnabled: vi.fn(() => true),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    tenantFeatureFlag: { findMany: mocks.flagFindMany },
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      mocks.transaction(callback, transactionClient),
  },
  setContentVersionContext: mocks.setActor,
  withTenantIsolationBypass: async <T>(callback: () => Promise<T>) => callback(),
}))

vi.mock('@pathfinder/billing', () => ({
  BillingServiceError: class BillingServiceError extends Error {},
  StripeBillingProvider: class StripeBillingProvider {},
  createStripeClient: vi.fn(),
  parseBillingEnvironment: vi.fn(),
  createManualBillingArrangement: vi.fn(),
  createBillingAccessOverride: vi.fn(),
  createTenantCheckout: vi.fn(),
  executeApprovedBillingAgentCommand: vi.fn(),
  getTenantBillingOverview: vi.fn(),
  reconcileBillingAccount: vi.fn(),
  recordManualPayment: vi.fn(),
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminBillingRouter } from './billing'

const app = router({ admin: adminBillingRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

describe('platform billing rollout control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
        callback(client),
    )
    mocks.tenantFindUnique.mockResolvedValue({ id: 'tenant-1', name: 'Museum' })
    mocks.flagFindMany.mockResolvedValue([])
    mocks.flagFindUnique.mockResolvedValue(null)
    mocks.flagUpsert.mockResolvedValue({
      flagKey: 'billing-ui-v1',
      enabled: true,
      setAt: new Date('2026-08-21T03:00:00.000Z'),
      setBy: 'admin-1',
    })
    mocks.auditCreate.mockResolvedValue({ id: 'audit-1' })
  })

  it('reports every billing gate with missing tenant rows disabled', async () => {
    const result = await app.createCaller(context()).admin.getBillingRollout({
      tenantId: 'tenant-1',
    })
    expect(result.flags).toHaveLength(5)
    expect(result.flags.every((flag) => !flag.tenantEnabled && !flag.effective)).toBe(true)
  })

  it('upserts an allowlisted flag and strictly audits the tenant-scoped transition', async () => {
    const result = await app.createCaller(context()).admin.setBillingTenantFlag({
      tenantId: 'tenant-1',
      flagKey: 'billing-ui-v1',
      enabled: true,
    })

    expect(mocks.setActor).toHaveBeenCalledWith(transactionClient, { actorId: 'admin-1' })
    expect(mocks.flagUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_flagKey: { tenantId: 'tenant-1', flagKey: 'billing-ui-v1' } },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          enabled: true,
          metadata: { source: 'platform-admin', system: 'billing' },
        }),
      }),
    )
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        action: 'admin.billing-rollout.enabled',
        targetType: 'TenantFeatureFlag',
      }),
    })
    expect(result).toMatchObject({ enabled: true, effective: true })
  })

  it('rejects unknown keys before database access', async () => {
    await expect(
      app.createCaller(context()).admin.setBillingTenantFlag({
        tenantId: 'tenant-1',
        flagKey: 'billing-unreviewed-v1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled()
  })

  it('requires platform-admin authorization', async () => {
    await expect(
      app.createCaller(context(false)).admin.getBillingRollout({ tenantId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
