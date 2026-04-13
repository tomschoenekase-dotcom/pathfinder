import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}))

import { writeAuditLog } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { operationalUpdateRouter } from './operational-update'

const venueFindFirst = vi.fn()
const placeFindFirst = vi.fn()
const operationalUpdateFindMany = vi.fn()
const operationalUpdateFindFirst = vi.fn()
const operationalUpdateCreate = vi.fn()
const operationalUpdateUpdateMany = vi.fn()

const mockDb = {
  venue: { findFirst: venueFindFirst },
  place: { findFirst: placeFindFirst },
  operationalUpdate: {
    findMany: operationalUpdateFindMany,
    findFirst: operationalUpdateFindFirst,
    create: operationalUpdateCreate,
    updateMany: operationalUpdateUpdateMany,
  },
} as unknown as TRPCContext['db']

const baseCtx = {
  db: mockDb,
  headers: new Headers(),
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: { userId: 'user_staff', activeTenantId: 'tenant_1', role: 'STAFF', isPlatformAdmin: false },
  }
}

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: { userId: 'user_manager', activeTenantId: 'tenant_1', role: 'MANAGER', isPlatformAdmin: false },
  }
}

const testRouter = router({ operationalUpdate: operationalUpdateRouter })

const baseUpdate = {
  id: 'cupdatetest1234567890',
  tenantId: 'tenant_1',
  venueId: 'cvenueabc123456789012',
  placeId: null,
  severity: 'WARNING' as const,
  title: 'East trail muddy',
  body: 'Use caution.',
  redirectTo: null,
  expiresAt: new Date('2030-01-01T12:00:00.000Z'),
  isActive: true,
  createdBy: 'user_other',
  createdAt: new Date('2030-01-01T08:00:00.000Z'),
  venue: { id: 'cvenueabc123456789012', name: 'City Zoo' },
  place: null,
}

describe('operational update router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('STAFF user cannot create a CLOSURE update', async () => {
    const caller = testRouter.createCaller(staffCtx())

    await expect(
      caller.operationalUpdate.create({
        venueId: 'cvenueabc123456789012',
        severity: 'CLOSURE',
        title: 'Reptile House closed',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))

    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(operationalUpdateCreate).not.toHaveBeenCalled()
  })

  it('expired update is not returned by list', async () => {
    operationalUpdateFindMany.mockResolvedValueOnce([baseUpdate])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.operationalUpdate.list()

    expect(result).toEqual([baseUpdate])
    expect(operationalUpdateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          isActive: true,
          expiresAt: expect.objectContaining({
            gt: expect.any(Date),
          }),
        }),
      }),
    )
  })

  it("MANAGER can deactivate an update they didn't create", async () => {
    operationalUpdateFindFirst.mockResolvedValueOnce(baseUpdate)
    operationalUpdateUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.operationalUpdate.deactivate({ id: baseUpdate.id })

    expect(result).toMatchObject({ id: baseUpdate.id, isActive: false, createdBy: 'user_other' })
    expect(operationalUpdateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: baseUpdate.id, tenantId: 'tenant_1' },
        data: { isActive: false },
      }),
    )
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user_manager',
        targetId: baseUpdate.id,
        action: 'operational-update.deactivated',
      }),
    )
  })
})
