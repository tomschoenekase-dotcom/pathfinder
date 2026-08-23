import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, transactionClient } = vi.hoisted(() => {
  const mocks = {
    venueFind: vi.fn(),
    floorFind: vi.fn(),
    floorsFind: vi.fn(),
    locationFind: vi.fn(),
    locationsFind: vi.fn(),
    locationCreate: vi.fn(),
    locationUpdateMany: vi.fn(),
    connectionsFind: vi.fn(),
    transaction: vi.fn(),
    lock: vi.fn(),
    audit: vi.fn(),
  }
  return {
    mocks,
    transactionClient: {
      venue: { findFirst: mocks.venueFind },
      venueFloor: { findFirst: mocks.floorFind, findMany: mocks.floorsFind },
      venueLocation: {
        findFirst: mocks.locationFind,
        findMany: mocks.locationsFind,
        create: mocks.locationCreate,
        updateMany: mocks.locationUpdateMany,
      },
      venueLocationConnection: { findMany: mocks.connectionsFind },
      auditLog: { create: vi.fn() },
    },
  }
})

vi.mock('@pathfinder/db', () => ({
  db: {
    ...transactionClient,
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      mocks.transaction(callback, transactionClient),
  },
  lockVenueContentMutation: mocks.lock,
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  writeAuditLogStrict: mocks.audit,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminLocationAuthoringRouter } from './location-authoring'

const app = router({ admin: adminLocationAuthoringRouter })
const operationId = '11111111-1111-4111-8111-111111111111'
const revision = new Date('2026-08-23T18:00:00.000Z')
const location = {
  id: operationId,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  stableKey: 'east-entrance',
  kind: 'ENTRANCE',
  displayName: 'East entrance',
  description: 'Accessible from Museum Way.',
  visibility: 'PUBLIC',
  floorId: null,
  parentLocationId: null,
  latitude: null,
  longitude: null,
  mapX: 12.5,
  mapY: 40,
  externalMapReference: 'https://museum.example/map',
  accessibilityMetadata: { stepFree: true },
  verifiedAt: revision,
  verifiedBy: 'admin-1',
  isActive: false,
  createdAt: revision,
  updatedAt: revision,
}
const createInput = {
  operationId,
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  stableKey: 'east-entrance',
  kind: 'ENTRANCE' as const,
  displayName: 'East entrance',
  description: 'Accessible from Museum Way.',
  visibility: 'PUBLIC' as const,
  floorId: null,
  parentLocationId: null,
  coordinates: null,
  mapAnchor: { x: 12.5, y: 40 },
  externalMapReference: 'https://museum.example/map',
  accessibilityMetadata: { stepFree: true },
}

function draftFields() {
  const fields: Partial<typeof createInput> = { ...createInput }
  delete fields.operationId
  return fields as Omit<typeof createInput, 'operationId'>
}

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin-1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transaction.mockImplementation(
    async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
      callback(client),
  )
  mocks.venueFind.mockResolvedValue({ id: 'venue-1', name: 'Museum' })
  mocks.floorFind.mockResolvedValue(null)
  mocks.floorsFind.mockResolvedValue([])
  mocks.locationsFind.mockResolvedValue([])
  mocks.connectionsFind.mockResolvedValue([])
  mocks.locationFind.mockResolvedValue(null)
  mocks.locationCreate.mockResolvedValue(location)
  mocks.locationUpdateMany.mockResolvedValue({ count: 1 })
  mocks.lock.mockResolvedValue(undefined)
  mocks.audit.mockResolvedValue(undefined)
})

describe('location authoring', () => {
  it('requires platform-admin authority and returns a bounded exact venue workspace', async () => {
    await expect(
      app
        .createCaller(context(false))
        .admin.getVenueLocationAuthoring({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      app
        .createCaller(context())
        .admin.getVenueLocationAuthoring({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).resolves.toEqual({
      venue: { id: 'venue-1', name: 'Museum' },
      floors: [],
      locations: [],
      connections: [],
    })
  })

  it('creates an inactive, strictly audited location draft and replays only exact input', async () => {
    const caller = app.createCaller(context())
    await expect(caller.admin.createVenueLocationDraft(createInput)).resolves.toMatchObject({
      location: { id: operationId, isActive: false, mapAnchor: { x: 12.5, y: 40 } },
      replayed: false,
    })
    expect(mocks.locationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: operationId, isActive: false }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: operationId,
        action: 'venue-location.draft-created',
      }),
      transactionClient,
    )

    mocks.locationFind.mockResolvedValue(location)
    await expect(caller.admin.createVenueLocationDraft(createInput)).resolves.toMatchObject({
      replayed: true,
    })
    await expect(
      caller.admin.createVenueLocationDraft({ ...createInput, displayName: 'Changed entrance' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects unsafe map URLs before touching storage', async () => {
    await expect(
      app.createCaller(context()).admin.createVenueLocationDraft({
        ...createInput,
        externalMapReference: 'https://museum.example/map?token=secret',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.locationFind).not.toHaveBeenCalled()
  })

  it('updates only an inactive exact revision and strictly audits the correction', async () => {
    mocks.locationFind.mockResolvedValue(location)
    const fields = draftFields()
    const result = await app.createCaller(context()).admin.updateVenueLocationDraft({
      ...fields,
      locationId: operationId,
      expectedUpdatedAt: revision,
      reason: 'Corrected against the current visitor map.',
      displayName: 'Accessible east entrance',
    })
    expect(result).toEqual({ updatedAt: expect.any(Date) })
    expect(mocks.locationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: operationId, updatedAt: revision, isActive: false }),
        data: expect.objectContaining({ displayName: 'Accessible east entrance' }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-location.draft-updated' }),
      transactionClient,
    )

    mocks.locationFind.mockResolvedValue({ ...location, isActive: true })
    await expect(
      app.createCaller(context()).admin.updateVenueLocationDraft({
        ...fields,
        locationId: operationId,
        expectedUpdatedAt: revision,
        reason: 'Should require deactivation.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('activates only the exact reviewed revision and strictly audits the public transition', async () => {
    mocks.locationFind.mockResolvedValue(location)
    const result = await app.createCaller(context()).admin.setVenueLocationAvailability({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      locationId: operationId,
      expectedUpdatedAt: revision,
      active: true,
      reason: 'Verified against the current visitor map.',
    })
    expect(result).toMatchObject({ location: { id: operationId, isActive: true }, replayed: false })
    expect(mocks.locationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: operationId, updatedAt: revision, isActive: false }),
        data: expect.objectContaining({ isActive: true, verifiedBy: 'admin-1' }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-location.activated' }),
      transactionClient,
    )

    mocks.locationFind.mockResolvedValue({
      ...location,
      updatedAt: new Date(revision.getTime() + 1),
    })
    await expect(
      app.createCaller(context()).admin.setVenueLocationAvailability({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        locationId: operationId,
        expectedUpdatedAt: revision,
        active: true,
        reason: 'Stale attempt.',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
