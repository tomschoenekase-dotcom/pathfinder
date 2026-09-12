import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  tenantFindUnique: vi.fn(),
  venueFindMany: vi.fn(),
  sessionCount: vi.fn(),
  messageCount: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  withTenantIsolationBypass: mocks.bypass,
  db: {
    tenant: { findUnique: mocks.tenantFindUnique, findMany: vi.fn() },
    venue: { findMany: mocks.venueFindMany, findFirst: vi.fn() },
    visitorSession: { count: mocks.sessionCount },
    message: { count: mocks.messageCount },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminClientReadsRouter } from './client-reads'

const caller = () =>
  router({ admin: adminClientReadsRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: null, role: 'STAFF', isPlatformAdmin: true },
  })

describe('admin client detail reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tenantFindUnique.mockResolvedValue({
      id: 'tenant-a',
      name: 'Tenant',
      memberships: [
        {
          id: 'membership-a',
          role: 'MANAGER',
          user: { id: 'user-a', email: 'a@test', fullName: 'A' },
        },
      ],
    })
    mocks.venueFindMany.mockResolvedValue([])
    mocks.sessionCount.mockResolvedValue(0)
    mocks.messageCount.mockResolvedValue(0)
  })

  it('returns stable user IDs only for active detail memberships', async () => {
    const result = await caller().admin.getClient({ tenantId: 'tenant-a' })
    expect(result.tenant.memberships[0]?.user.id).toBe('user-a')
    expect(mocks.tenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          memberships: expect.objectContaining({
            where: { status: 'ACTIVE' },
            select: expect.objectContaining({
              user: { select: { id: true, email: true, fullName: true } },
            }),
          }),
        }),
      }),
    )
  })
})
