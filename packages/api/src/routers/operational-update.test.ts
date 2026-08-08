import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', () => ({
  lockContentVersionEntity: vi.fn().mockResolvedValue(undefined),
  lockOperationalUpdateCapacity: vi.fn().mockResolvedValue(undefined),
  setContentVersionContext: vi.fn().mockResolvedValue(undefined),
  writeAuditLogStrict: vi.fn().mockResolvedValue(undefined),
}))

import {
  lockContentVersionEntity,
  lockOperationalUpdateCapacity,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { operationalUpdateRouter } from './operational-update'

const venueFindFirst = vi.fn()
const placeFindFirst = vi.fn()
const operationalUpdateFindMany = vi.fn()
const operationalUpdateFindFirst = vi.fn()
const operationalUpdateCreate = vi.fn()
const operationalUpdateUpdateMany = vi.fn()
const operationalUpdateCount = vi.fn()
const auditLogCreate = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(mockDb)),
  venue: { findFirst: venueFindFirst },
  place: { findFirst: placeFindFirst },
  operationalUpdate: {
    findMany: operationalUpdateFindMany,
    findFirst: operationalUpdateFindFirst,
    create: operationalUpdateCreate,
    count: operationalUpdateCount,
    updateMany: operationalUpdateUpdateMany,
  },
  auditLog: { create: auditLogCreate },
} as unknown as TRPCContext['db']

const baseCtx = { db: mockDb, headers: new Headers() }

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_staff',
      activeTenantId: 'tenant_1',
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  }
}

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_manager',
      activeTenantId: 'tenant_1',
      role: 'MANAGER',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ operationalUpdate: operationalUpdateRouter })
const startsAt = new Date('2030-01-01T08:00:00.000Z')
const expiresAt = new Date('2030-01-01T12:00:00.000Z')
const updatedAt = new Date('2029-12-31T23:00:00.000Z')
const inputFields = {
  venueId: 'cvenueabc123456789012',
  placeId: null,
  updateType: 'TEMPORARY_CLOSURE' as const,
  severity: 'CLOSURE' as const,
  priority: 'URGENT' as const,
  title: 'Reptile House closed',
  body: 'Use the west trail.',
  redirectTo: '/west-trail',
  startsAt,
  expiresAt,
}
const baseUpdate = {
  id: 'cupdatetest1234567890',
  tenantId: 'tenant_1',
  ...inputFields,
  status: 'PUBLISHED' as const,
  isActive: true,
  createdBy: 'user_other',
  publishedBy: 'user_other',
  publishedAt: startsAt,
  createdAt: startsAt,
  updatedAt,
  venue: { id: inputFields.venueId, name: 'City Zoo' },
  place: null,
}

describe('operational update router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    venueFindFirst.mockResolvedValue({ id: inputFields.venueId })
    operationalUpdateCount.mockResolvedValue(0)
  })

  it('denies STAFF creation before any database write', async () => {
    const caller = testRouter.createCaller(staffCtx())
    await expect(
      caller.operationalUpdate.create({ ...inputFields, publish: true }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(operationalUpdateCreate).not.toHaveBeenCalled()
  })

  it('returns the complete tenant lifecycle for management', async () => {
    operationalUpdateFindMany.mockResolvedValueOnce([baseUpdate])
    const result = await testRouter.createCaller(staffCtx()).operationalUpdate.list()
    expect(result).toEqual([baseUpdate])
    expect(operationalUpdateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1' },
        take: 500,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    )
  })

  it('creates a draft that is not guest-visible', async () => {
    const draft = {
      ...baseUpdate,
      status: 'DRAFT' as const,
      isActive: false,
      publishedBy: null,
      publishedAt: null,
      createdBy: 'user_manager',
    }
    operationalUpdateCreate.mockResolvedValueOnce(draft)

    const result = await testRouter
      .createCaller(managerCtx())
      .operationalUpdate.create({ ...inputFields, publish: false })

    expect(result).toEqual(draft)
    expect(operationalUpdateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          status: 'DRAFT',
          isActive: false,
          publishedBy: null,
          publishedAt: null,
        }),
      }),
    )
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operational-update.created-draft' }),
      mockDb,
    )
  })

  it('publishes a current draft using compare-and-set state', async () => {
    const draft = {
      ...baseUpdate,
      status: 'DRAFT' as const,
      isActive: false,
      publishedBy: null,
      publishedAt: null,
    }
    operationalUpdateFindFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(baseUpdate)
    operationalUpdateUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(managerCtx()).operationalUpdate.publish({
      id: baseUpdate.id,
      expectedUpdatedAt: updatedAt,
    })

    expect(result.status).toBe('PUBLISHED')
    expect(lockContentVersionEntity).toHaveBeenCalledWith(mockDb, {
      tenantId: 'tenant_1',
      entityType: 'OPERATIONAL_UPDATE',
      entityId: baseUpdate.id,
    })
    expect(operationalUpdateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: baseUpdate.id,
          tenantId: 'tenant_1',
          status: 'DRAFT',
          updatedAt,
        }),
        data: expect.objectContaining({ status: 'PUBLISHED', isActive: true }),
      }),
    )
    expect(lockOperationalUpdateCapacity).toHaveBeenCalledWith(mockDb, {
      tenantId: 'tenant_1',
      venueId: inputFields.venueId,
    })
  })

  it('rejects publishing when the venue prompt is already at capacity', async () => {
    const draft = {
      ...baseUpdate,
      status: 'DRAFT' as const,
      isActive: false,
      publishedBy: null,
      publishedAt: null,
    }
    operationalUpdateFindFirst.mockResolvedValueOnce(draft)
    operationalUpdateCount.mockResolvedValueOnce(20)

    await expect(
      testRouter.createCaller(managerCtx()).operationalUpdate.publish({
        id: baseUpdate.id,
        expectedUpdatedAt: updatedAt,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(operationalUpdateUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('rejects a stale edit without a false audit', async () => {
    operationalUpdateFindFirst.mockResolvedValueOnce(baseUpdate)
    operationalUpdateUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      testRouter.createCaller(managerCtx()).operationalUpdate.update({
        id: baseUpdate.id,
        expectedUpdatedAt: updatedAt,
        ...inputFields,
        title: 'Changed concurrently',
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'CONFLICT' }))
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it("lets a manager deactivate another author's published update with CAS", async () => {
    operationalUpdateFindFirst
      .mockResolvedValueOnce(baseUpdate)
      .mockResolvedValueOnce({ ...baseUpdate, isActive: false })
    operationalUpdateUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(managerCtx()).operationalUpdate.deactivate({
      id: baseUpdate.id,
      expectedUpdatedAt: updatedAt,
    })

    expect(result).toMatchObject({ id: baseUpdate.id, isActive: false, createdBy: 'user_other' })
    expect(operationalUpdateUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: baseUpdate.id,
          tenantId: 'tenant_1',
          status: 'PUBLISHED',
          isActive: true,
          updatedAt,
        }),
        data: { isActive: false },
      }),
    )
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user_manager',
        targetId: baseUpdate.id,
        action: 'operational-update.deactivated',
      }),
      mockDb,
    )
  })
})
