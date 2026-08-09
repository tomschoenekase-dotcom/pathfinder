import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirst, updateMany, auditCreate, transaction, lockVenue, setActor, transactionClient } =
  vi.hoisted(() => {
    const findFirst = vi.fn()
    const updateMany = vi.fn()
    const auditCreate = vi.fn()
    return {
      findFirst,
      updateMany,
      auditCreate,
      transaction: vi.fn(),
      lockVenue: vi.fn(),
      setActor: vi.fn(),
      transactionClient: {
        venue: { findFirst, updateMany },
        auditLog: { create: auditCreate },
      },
    }
  })

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: transactionClient.venue,
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      transaction(callback, transactionClient),
  },
  lockVenueContentMutation: lockVenue,
  setContentVersionContext: setActor,
  withTenantIsolationBypass: async <T>(callback: () => Promise<T>) => callback(),
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminVenueAvailabilityRouter } from './venue-availability'

const app = router({ admin: adminVenueAvailabilityRouter })
const revision = new Date('2026-08-08T12:00:00.000Z')

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

beforeEach(() => {
  vi.resetAllMocks()
  transaction.mockImplementation(
    async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
      callback(client),
  )
  lockVenue.mockResolvedValue(undefined)
  setActor.mockResolvedValue(undefined)
  updateMany.mockResolvedValue({ count: 1 })
  auditCreate.mockResolvedValue({ id: 'audit_1' })
})

describe('platform venue availability control', () => {
  it('requires platform-admin authorization before reads or writes', async () => {
    const caller = app.createCaller(context(false))
    await expect(
      caller.admin.getVenueAvailability({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.admin.setVenueAvailability({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedUpdatedAt: revision,
        reason: 'Incident',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('returns exact tenant-scoped availability', async () => {
    findFirst.mockResolvedValue({ id: 'venue_1', isActive: true, updatedAt: revision })
    await expect(
      app
        .createCaller(context(true))
        .admin.getVenueAvailability({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).resolves.toEqual({ id: 'venue_1', isActive: true, updatedAt: revision })
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true, isActive: true, updatedAt: true },
    })
  })

  it('changes the exact revision and strictly audits in one transaction', async () => {
    findFirst.mockResolvedValue({ id: 'venue_1', isActive: true, updatedAt: revision })
    const result = await app.createCaller(context(true)).admin.setVenueAvailability({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: false,
      expectedUpdatedAt: revision,
      reason: 'Provider incident',
    })

    expect(setActor).toHaveBeenCalledWith(transactionClient, { actorId: 'admin_1' })
    expect(lockVenue).toHaveBeenCalledWith(transactionClient, {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      enabled: false,
      expectedUpdatedAt: revision,
      reason: 'Provider incident',
    })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'venue_1',
          tenantId: 'tenant_1',
          isActive: true,
          updatedAt: revision,
        }),
        data: expect.objectContaining({ isActive: false }),
      }),
    )
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        action: 'admin.venue-availability.disabled',
        afterState: { enabled: false, reason: 'Provider incident' },
      }),
    })
    expect(result).toMatchObject({ isActive: false, replayed: false })
  })

  it('rejects a stale revision and propagates strict audit failure', async () => {
    findFirst.mockResolvedValue({
      id: 'venue_1',
      isActive: true,
      updatedAt: new Date(revision.getTime() + 1),
    })
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.setVenueAvailability({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedUpdatedAt: revision,
        reason: 'Incident',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(updateMany).not.toHaveBeenCalled()

    findFirst.mockResolvedValue({ id: 'venue_1', isActive: true, updatedAt: revision })
    auditCreate.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      caller.admin.setVenueAvailability({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedUpdatedAt: revision,
        reason: 'Incident',
      }),
    ).rejects.toThrow('audit unavailable')
  })
})
