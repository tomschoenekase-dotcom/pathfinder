import { beforeEach, describe, expect, it, vi } from 'vitest'

const actions = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  schedule: vi.fn(),
  expire: vi.fn(),
}))

vi.mock('@pathfinder/db', () => {
  class OperationalUpdateActionError extends Error {
    constructor(
      readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT',
      message: string,
    ) {
      super(message)
    }
  }
  return {
    createOperationalUpdateAction: actions.create,
    updateOperationalUpdateAction: actions.update,
    scheduleOperationalUpdateAction: actions.schedule,
    expireOperationalUpdateAction: actions.expire,
    OperationalUpdateActionError,
    operationalUpdateActionSelect: { id: true },
  }
})

import { OperationalUpdateActionError } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { operationalUpdateRouter } from './operational-update'

const findMany = vi.fn()
const findFirst = vi.fn()
const mockDb = {
  operationalUpdate: { findMany, findFirst },
} as unknown as TRPCContext['db']
const context = (role: 'STAFF' | 'MANAGER' | 'OWNER'): TRPCContext => ({
  db: mockDb,
  headers: new Headers(),
  session: {
    userId: `user_${role.toLowerCase()}`,
    activeTenantId: 'tenant_1',
    role,
    isPlatformAdmin: false,
  },
})
const testRouter = router({ operationalUpdate: operationalUpdateRouter })
const startsAt = new Date('2030-01-01T08:00:00.000Z')
const expiresAt = new Date('2030-01-01T12:00:00.000Z')
const expectedUpdatedAt = new Date('2029-12-31T23:00:00.000Z')
const fields = {
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
const update = { id: 'cupdatetest1234567890', tenantId: 'tenant_1', ...fields }

describe('operational update router adapters', () => {
  beforeEach(() => vi.resetAllMocks())

  it('denies STAFF writes before invoking the canonical action', async () => {
    await expect(
      testRouter.createCaller(context('STAFF')).operationalUpdate.create({
        ...fields,
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(actions.create).not.toHaveBeenCalled()
  })

  it('passes authenticated tenant and human manager authority to create', async () => {
    actions.create.mockResolvedValue({ update, preview: {} })
    const result = await testRouter.createCaller(context('MANAGER')).operationalUpdate.create({
      ...fields,
      publish: true,
    })
    expect(result).toEqual(update)
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        actor: { type: 'HUMAN', id: 'user_manager', role: 'MANAGER' },
        schedule: true,
      }),
      mockDb,
    )
  })

  it('delegates update, schedule, and expiry with CAS timestamps', async () => {
    actions.update.mockResolvedValue({ update, preview: {} })
    actions.schedule.mockResolvedValue({ update, preview: {} })
    actions.expire.mockResolvedValue({ update, preview: {} })
    const caller = testRouter.createCaller(context('OWNER')).operationalUpdate
    await caller.update({ id: update.id, expectedUpdatedAt, ...fields, publish: false })
    await caller.publish({ id: update.id, expectedUpdatedAt })
    await caller.deactivate({ id: update.id, expectedUpdatedAt })
    const authority = expect.objectContaining({
      tenantId: 'tenant_1',
      actor: { type: 'HUMAN', id: 'user_owner', role: 'OWNER' },
      id: update.id,
      expectedUpdatedAt,
    })
    expect(actions.update).toHaveBeenCalledWith(authority, mockDb)
    expect(actions.schedule).toHaveBeenCalledWith(authority, mockDb)
    expect(actions.expire).toHaveBeenCalledWith(authority, mockDb)
  })

  it('maps typed domain errors without leaking adapter internals', async () => {
    actions.schedule.mockRejectedValue(
      new OperationalUpdateActionError('CONFLICT', 'Update changed; refresh'),
    )
    await expect(
      testRouter.createCaller(context('MANAGER')).operationalUpdate.publish({
        id: update.id,
        expectedUpdatedAt,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Update changed; refresh' })
  })

  it('keeps reads exactly tenant scoped', async () => {
    findMany.mockResolvedValue([update])
    await testRouter.createCaller(context('STAFF')).operationalUpdate.list()
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant_1' }, take: 500 }),
    )
  })
})
