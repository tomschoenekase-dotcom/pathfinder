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

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminTochiRolloutRouter } from './tochi-rollout'

const app = router({ admin: adminTochiRolloutRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

describe('platform Tochi rollout control', () => {
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
      flagKey: 'client-tochi-v1',
      enabled: true,
      setAt: new Date('2026-08-19T12:00:00.000Z'),
      setBy: 'admin-1',
    })
    mocks.auditCreate.mockResolvedValue({ id: 'audit-1' })
  })

  it('requires platform-admin authorization before reading or changing rollout', async () => {
    const caller = app.createCaller(context(false))
    await expect(caller.admin.getTochiRollout({ tenantId: 'tenant-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      caller.admin.setTochiTenantFlag({
        tenantId: 'tenant-1',
        flagKey: 'client-tochi-v1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled()
  })

  it('reports all four server and tenant gates without treating missing rows as enabled', async () => {
    mocks.flagFindMany.mockResolvedValue([
      {
        flagKey: 'client-tochi-v1',
        enabled: true,
        setAt: new Date('2026-08-19T12:00:00.000Z'),
        setBy: 'admin-1',
      },
    ])
    const result = await app
      .createCaller(context(true))
      .admin.getTochiRollout({ tenantId: 'tenant-1' })
    expect(result.flags).toHaveLength(4)
    expect(result.flags[0]).toMatchObject({
      tenantFlagKey: 'client-tochi-v1',
      tenantEnabled: true,
      effective: false,
    })
    expect(result.flags.slice(1).every((flag) => !flag.tenantEnabled)).toBe(true)
  })

  it('upserts only an allowlisted tenant flag and audits the exact change transactionally', async () => {
    const result = await app.createCaller(context(true)).admin.setTochiTenantFlag({
      tenantId: 'tenant-1',
      flagKey: 'client-tochi-v1',
      enabled: true,
    })
    expect(mocks.setActor).toHaveBeenCalledWith(transactionClient, { actorId: 'admin-1' })
    expect(mocks.flagUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_flagKey: { tenantId: 'tenant-1', flagKey: 'client-tochi-v1' },
        },
        create: expect.objectContaining({ tenantId: 'tenant-1', enabled: true }),
      }),
    )
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        actorId: 'admin-1',
        action: 'admin.tochi-rollout.enabled',
        afterState: { enabled: true, flagKey: 'client-tochi-v1' },
      }),
    })
    expect(result).toMatchObject({ enabled: true, effective: false })
  })

  it('rejects unknown keys before any database access', async () => {
    await expect(
      app.createCaller(context(true)).admin.setTochiTenantFlag({
        tenantId: 'tenant-1',
        flagKey: 'unreviewed-character-v1',
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled()
  })
})
