import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tenantFindUnique, tenantMembershipFindMany } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantMembershipFindMany: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    tenant: {
      findUnique: tenantFindUnique,
    },
    tenantMembership: {
      findMany: tenantMembershipFindMany,
    },
  },
}))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { tenantRouter } from './tenant'

const baseCtx = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
}

function tenantCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'OWNER',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ tenant: tenantRouter })

describe('tenant router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('tenant.getSettings returns the current tenant and members', async () => {
    const tenant = {
      id: 'tenant_1',
      name: 'Pathfinder Demo',
      slug: 'pathfinder-demo',
      planTier: 'pro',
      status: 'ACTIVE',
      nextPaymentDue: new Date('2026-07-15T00:00:00.000Z'),
    }
    const members = [
      {
        id: 'membership_1',
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date('2026-06-01T00:00:00.000Z'),
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        user: {
          id: 'user_1',
          email: 'owner@example.com',
          fullName: 'Owner User',
          avatarUrl: null,
        },
      },
    ]

    tenantFindUnique.mockResolvedValueOnce(tenant)
    tenantMembershipFindMany.mockResolvedValueOnce(members)

    const caller = testRouter.createCaller(tenantCtx())
    const result = await caller.tenant.getSettings()

    expect(result).toEqual({ tenant, members })
    expect(tenantFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant_1' },
        select: expect.objectContaining({
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          nextPaymentDue: true,
        }),
      }),
    )
  })

  it('tenant.getSettings throws NOT_FOUND when the tenant is missing', async () => {
    tenantFindUnique.mockResolvedValueOnce(null)
    tenantMembershipFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(tenantCtx())

    await expect(caller.tenant.getSettings()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })

  it('tenant.getSettings excludes removed memberships', async () => {
    tenantFindUnique.mockResolvedValueOnce({
      id: 'tenant_1',
      name: 'Pathfinder Demo',
      slug: 'pathfinder-demo',
      planTier: 'free',
      status: 'ACTIVE',
      nextPaymentDue: null,
    })
    tenantMembershipFindMany.mockResolvedValueOnce([])

    const caller = testRouter.createCaller(tenantCtx())
    await caller.tenant.getSettings()

    expect(tenantMembershipFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', status: { not: 'REMOVED' } },
      }),
    )
  })
})
