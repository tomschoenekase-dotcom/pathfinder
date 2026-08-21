import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  refresh: vi.fn(),
  bypass: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}))

vi.mock('@pathfinder/db', () => ({
  db: { accountSummary: { findMany: mocks.findMany } },
  refreshAccountSummaryAction: mocks.refresh,
  withTenantIsolationBypass: mocks.bypass,
}))

import { processStaleAccountSummaries } from './account-summary-refresh'

describe('processStaleAccountSummaries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refreshes a bounded distinct batch with honest system attribution', async () => {
    mocks.findMany.mockResolvedValue([
      { tenantId: 'tenant_1', organizationId: 'org_1' },
      { tenantId: 'tenant_2', organizationId: 'org_2' },
    ])
    mocks.refresh.mockResolvedValue({ replayed: false })

    await expect(
      processStaleAccountSummaries({ systemJobId: 'bull-job-7', batchSize: 500 }),
    ).resolves.toEqual({ scanned: 2, refreshed: 2 })

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'STALE', tenantId: { not: null } },
        distinct: ['tenantId', 'organizationId'],
        take: 100,
      }),
    )
    expect(mocks.refresh).toHaveBeenNthCalledWith(1, {
      clientId: 'tenant_1',
      organizationId: 'org_1',
      actor: {
        type: 'SYSTEM',
        actorId: 'account-summary-refresh-worker',
        role: 'SYSTEM',
        systemJobId: 'bull-job-7',
      },
    })
  })

  it('leaves a failed item for BullMQ or the next durable scan to retry', async () => {
    mocks.findMany.mockResolvedValue([{ tenantId: 'tenant_1', organizationId: 'org_1' }])
    mocks.refresh.mockRejectedValue(new Error('database unavailable'))

    await expect(processStaleAccountSummaries()).rejects.toThrow('database unavailable')
  })
})
