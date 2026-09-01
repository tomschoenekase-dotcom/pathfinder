import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findTenant,
  findBudget,
  createBudget,
  updateBudget,
  reconcileExpired,
  writeAudit,
  transaction,
} = vi.hoisted(() => ({
  findTenant: vi.fn(),
  findBudget: vi.fn(),
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  reconcileExpired: vi.fn(),
  writeAudit: vi.fn(),
  transaction: vi.fn(),
}))

const transactionClient = {
  tenant: { findUnique: findTenant },
  aiCostBudget: {
    findFirst: findBudget,
    findFirstOrThrow: findBudget,
    create: createBudget,
    updateMany: updateBudget,
  },
}

vi.mock('@pathfinder/db', () => ({
  AI_COST_BUDGET_COVERAGE_VERSION: 'gateway-v1',
  db: {
    tenant: { findUnique: findTenant },
    aiCostBudget: { findFirst: findBudget },
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      transaction(callback, transactionClient),
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  reconcileExpiredAiCostAttempts: reconcileExpired,
  writeAuditLogStrict: writeAudit,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminCostBudgetRouter } from './cost-budget'

const app = router({ admin: adminCostBudgetRouter })
const startsAt = new Date('2026-08-08T20:00:00.000Z')
const endsAt = new Date('2027-08-09T20:00:00.000Z')

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

function budget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'budget_1',
    tenantId: 'tenant_1',
    coverageVersion: 'gateway-v1',
    enabled: true,
    startsAt,
    endsAt,
    limitUnits: 10_000_000_000n,
    remainingUnits: 9_000_000_000n,
    reservedUnits: 200_000_000n,
    committedUnits: 800_000_000n,
    epoch: 1,
    revision: 3,
    breachedAt: null,
    updatedBy: 'admin_1',
    reason: 'Synthetic operating envelope',
    createdAt: startsAt,
    updatedAt: startsAt,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  findTenant.mockResolvedValue({ id: 'tenant_1' })
  findBudget.mockResolvedValue(null)
  updateBudget.mockResolvedValue({ count: 1 })
  createBudget.mockImplementation(async ({ data }) => budget({ ...data, revision: 1 }))
  writeAudit.mockResolvedValue(undefined)
  reconcileExpired.mockResolvedValue({ scanned: 0, settled: 0, raced: 0 })
  transaction.mockImplementation(
    async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
      callback(client),
  )
})

describe('platform AI cost budget control', () => {
  it('requires platform-admin authorization', async () => {
    const caller = app.createCaller(context(false))
    await expect(caller.admin.getAiCostBudget({ tenantId: 'tenant_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(findTenant).not.toHaveBeenCalled()
  })

  it('returns an explicit unconfigured gateway-v1 state with complete coverage', async () => {
    await expect(
      app.createCaller(context(true)).admin.getAiCostBudget({ tenantId: 'tenant_1' }),
    ).resolves.toEqual({
      configured: false,
      version: 'gateway-v1',
      excludedProviderPaths: [],
    })
  })

  it('creates the first envelope with exact units and strict audit', async () => {
    const result = await app.createCaller(context(true)).admin.setAiCostBudget({
      tenantId: 'tenant_1',
      enabled: true,
      startsAt,
      endsAt,
      hardLimitUsd: '100.00000000',
      reason: 'Synthetic operating envelope',
      expectedRevision: null,
    })

    expect(createBudget).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        limitUnits: 10_000_000_000n,
        remainingUnits: 10_000_000_000n,
      }),
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.ai-cost-budget.enabled',
        tenantId: 'tenant_1',
        afterState: expect.objectContaining({ coverageVersion: 'gateway-v1' }),
      }),
      transactionClient,
    )
    expect(result).toMatchObject({ configured: true, hardLimitUsd: '100.00000000' })
  })

  it('rejects stale revisions and limits below current exposure', async () => {
    findBudget.mockResolvedValue(budget())
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.setAiCostBudget({
        tenantId: 'tenant_1',
        enabled: true,
        startsAt,
        endsAt,
        hardLimitUsd: '100.00000000',
        reason: 'Synthetic operating envelope',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.admin.setAiCostBudget({
        tenantId: 'tenant_1',
        enabled: true,
        startsAt,
        endsAt,
        hardLimitUsd: '9.00000000',
        reason: 'Synthetic operating envelope',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('bounds storage input and maps a concurrent first create to a refresh conflict', async () => {
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.setAiCostBudget({
        tenantId: 'tenant_1',
        enabled: true,
        startsAt,
        endsAt,
        hardLimitUsd: '10000001.00000000',
        reason: 'Exceeds the technical storage boundary',
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    createBudget.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      caller.admin.setAiCostBudget({
        tenantId: 'tenant_1',
        enabled: true,
        startsAt,
        endsAt,
        hardLimitUsd: '100.00000000',
        reason: 'Concurrent first configuration',
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('replays an exact envelope without a duplicate write or audit', async () => {
    findBudget.mockResolvedValue(budget())
    await expect(
      app.createCaller(context(true)).admin.setAiCostBudget({
        tenantId: 'tenant_1',
        enabled: true,
        startsAt,
        endsAt,
        hardLimitUsd: '100.00000000',
        reason: 'Synthetic operating envelope',
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ replayed: true, revision: 3 })
    expect(updateBudget).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('fences an active-budget update on the exact accounting snapshot', async () => {
    findBudget.mockResolvedValue(budget())
    await app.createCaller(context(true)).admin.setAiCostBudget({
      tenantId: 'tenant_1',
      enabled: false,
      startsAt,
      endsAt,
      hardLimitUsd: '100.00000000',
      reason: 'Pause this envelope for maintenance',
      expectedRevision: 3,
    })

    expect(updateBudget).toHaveBeenCalledWith({
      where: expect.objectContaining({
        revision: 3,
        remainingUnits: 9_000_000_000n,
        reservedUnits: 200_000_000n,
        committedUnits: 800_000_000n,
        breachedAt: null,
      }),
      data: expect.anything(),
    })
  })

  it('resets only a disabled window with no live reservations and audits the new epoch', async () => {
    findBudget.mockResolvedValue(
      budget({
        enabled: false,
        reservedUnits: 0n,
        committedUnits: 1_000_000_000n,
        remainingUnits: 9_000_000_000n,
      }),
    )
    const nextStartsAt = new Date('2026-08-10T00:00:00.000Z')
    const nextEndsAt = new Date('2027-08-10T00:00:00.000Z')

    await app.createCaller(context(true)).admin.resetAiCostBudgetWindow({
      tenantId: 'tenant_1',
      startsAt: nextStartsAt,
      endsAt: nextEndsAt,
      reason: 'Begin the next approved operating window',
      expectedRevision: 3,
    })

    expect(reconcileExpired).toHaveBeenCalledWith({ db: expect.anything(), tenantId: 'tenant_1' })
    expect(updateBudget).toHaveBeenCalledWith({
      where: expect.objectContaining({ enabled: false, revision: 3, reservedUnits: 0n }),
      data: expect.objectContaining({
        remainingUnits: 10_000_000_000n,
        committedUnits: 0n,
        breachedAt: null,
        epoch: { increment: 1 },
        revision: { increment: 1 },
      }),
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.ai-cost-budget.window-reset' }),
      transactionClient,
    )
  })

  it('refuses to reset an enabled budget or one with live reservations', async () => {
    const caller = app.createCaller(context(true))
    findBudget.mockResolvedValue(budget())
    await expect(
      caller.admin.resetAiCostBudgetWindow({
        tenantId: 'tenant_1',
        startsAt,
        endsAt,
        reason: 'Unsafe enabled reset',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    findBudget.mockResolvedValue(budget({ enabled: false }))
    await expect(
      caller.admin.resetAiCostBudgetWindow({
        tenantId: 'tenant_1',
        startsAt,
        endsAt,
        reason: 'Unsafe live-reservation reset',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(writeAudit).not.toHaveBeenCalled()
  })
})
