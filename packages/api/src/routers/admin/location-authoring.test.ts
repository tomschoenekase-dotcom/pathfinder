import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks, transactionClient } = vi.hoisted(() => {
  const mocks = {
    venueFind: vi.fn(),
    floorFind: vi.fn(),
    floorCreate: vi.fn(),
    floorUpdateMany: vi.fn(),
    floorsFind: vi.fn(),
    locationFind: vi.fn(),
    locationsFind: vi.fn(),
    locationCreate: vi.fn(),
    locationUpdateMany: vi.fn(),
    connectionsFind: vi.fn(),
    connectionFind: vi.fn(),
    connectionCreate: vi.fn(),
    connectionUpdateMany: vi.fn(),
    proposalsFind: vi.fn(),
    proposalFind: vi.fn(),
    actionCreate: vi.fn(),
    timelineCreate: vi.fn(),
    transaction: vi.fn(),
    lock: vi.fn(),
    audit: vi.fn(),
  }
  return {
    mocks,
    transactionClient: {
      venue: { findFirst: mocks.venueFind },
      venueFloor: {
        findFirst: mocks.floorFind,
        findMany: mocks.floorsFind,
        create: mocks.floorCreate,
        updateMany: mocks.floorUpdateMany,
      },
      venueLocation: {
        findFirst: mocks.locationFind,
        findMany: mocks.locationsFind,
        create: mocks.locationCreate,
        updateMany: mocks.locationUpdateMany,
      },
      venueLocationConnection: {
        findMany: mocks.connectionsFind,
        findFirst: mocks.connectionFind,
        create: mocks.connectionCreate,
        updateMany: mocks.connectionUpdateMany,
      },
      approvalRequest: { findMany: mocks.proposalsFind, findFirst: mocks.proposalFind },
      agentAction: { create: mocks.actionCreate },
      agentTimelineEvent: { create: mocks.timelineCreate },
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

import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminLocationAuthoringRouter } from './location-authoring'
import { adminLocationAvailabilityRouter } from './location-availability'
import { adminLocationAuthoringApplicationRouter } from './location-proposal-application'
import { adminLocationConnectionAuthoringRouter } from './location-connection-authoring'
import { adminLocationFloorAuthoringRouter } from './location-floor-authoring'

const app = router({
  admin: mergeRouters(
    adminLocationAuthoringRouter,
    adminLocationAvailabilityRouter,
    adminLocationAuthoringApplicationRouter,
    adminLocationFloorAuthoringRouter,
    adminLocationConnectionAuthoringRouter,
  ),
})
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
const floor = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  stableKey: 'ground-floor',
  name: 'Ground floor',
  level: 0,
  sortOrder: 0,
  mapImageUrl: 'https://museum.example/ground-floor-map.png',
  isActive: false,
  createdAt: revision,
  updatedAt: revision,
}
const connection = {
  id: '55555555-5555-4555-8555-555555555555',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  fromLocationId: operationId,
  toLocationId: '66666666-6666-4666-8666-666666666666',
  kind: 'WALKWAY',
  bidirectional: true,
  accessible: true,
  directions: 'Follow the marked level path.',
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

function proposalDraftFields() {
  return {
    stableKey: createInput.stableKey,
    kind: createInput.kind,
    displayName: createInput.displayName,
    description: createInput.description,
    visibility: createInput.visibility,
    floorId: createInput.floorId,
    parentLocationId: createInput.parentLocationId,
    coordinates: createInput.coordinates,
    mapAnchor: createInput.mapAnchor,
    externalMapReference: createInput.externalMapReference,
    accessibilityMetadata: createInput.accessibilityMetadata,
  }
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
  vi.resetAllMocks()
  mocks.transaction.mockImplementation(
    async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
      callback(client),
  )
  mocks.venueFind.mockResolvedValue({ id: 'venue-1', name: 'Museum' })
  mocks.floorFind.mockResolvedValue(null)
  mocks.floorCreate.mockResolvedValue(floor)
  mocks.floorUpdateMany.mockResolvedValue({ count: 1 })
  mocks.floorsFind.mockResolvedValue([])
  mocks.locationsFind.mockResolvedValue([])
  mocks.connectionsFind.mockResolvedValue([])
  mocks.connectionFind.mockResolvedValue(null)
  mocks.connectionCreate.mockResolvedValue(connection)
  mocks.connectionUpdateMany.mockResolvedValue({ count: 1 })
  mocks.proposalsFind.mockResolvedValue([])
  mocks.proposalFind.mockResolvedValue(null)
  mocks.locationFind.mockResolvedValue(null)
  mocks.locationCreate.mockResolvedValue(location)
  mocks.locationUpdateMany.mockResolvedValue({ count: 1 })
  mocks.actionCreate.mockResolvedValue({ id: 'action-1' })
  mocks.timelineCreate.mockResolvedValue({ id: 'timeline-1' })
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
      proposals: [],
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

  it('applies an exact human-approved proposal as an inactive draft without activation', async () => {
    mocks.proposalFind.mockResolvedValue({
      id: operationId,
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        draft: proposalDraftFields(),
        canonicalVenueContentChanged: false,
      },
      agentRun: { requestedOperation: 'prepare location anchor' },
      decision: {
        id: 'decision-1',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        createdAt: revision,
        resultingAction: null,
      },
    })
    const result = await app.createCaller(context()).admin.applyApprovedVenueLocationDraft({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      approvalRequestId: operationId,
      expectedDecisionAt: revision,
      reason: 'Approval and source evidence reviewed.',
    })
    expect(result).toMatchObject({
      location: { id: operationId, isActive: false },
      replayed: false,
    })
    expect(mocks.locationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: operationId, isActive: false }),
      }),
    )
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalDecisionId: 'decision-1',
          actionName: 'torchiko.locations.apply_approved_draft',
        }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-location.approved-draft-applied' }),
      transactionClient,
    )
  })

  it('never applies a proposal without current human approval', async () => {
    mocks.proposalFind.mockResolvedValue({
      id: operationId,
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      scopeSnapshot: {},
      agentRun: { requestedOperation: 'prepare location anchor' },
      decision: null,
    })
    await expect(
      app.createCaller(context()).admin.applyApprovedVenueLocationDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        approvalRequestId: operationId,
        expectedDecisionAt: revision,
        reason: 'Should not apply.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.locationCreate).not.toHaveBeenCalled()
  })

  it('fails closed when an approved payload does not match the request tenant and venue', async () => {
    mocks.proposalFind.mockResolvedValue({
      id: operationId,
      agentIdentityId: 'agent-1',
      agentRunId: 'run-1',
      scopeSnapshot: {
        contractVersion: 1,
        tenantId: 'tenant-other',
        venueId: 'venue-other',
        draft: proposalDraftFields(),
        canonicalVenueContentChanged: false,
      },
      agentRun: { requestedOperation: 'prepare location anchor' },
      decision: {
        id: 'decision-1',
        decision: 'APPROVED',
        decidedByType: 'HUMAN',
        createdAt: revision,
        resultingAction: null,
      },
    })
    await expect(
      app.createCaller(context()).admin.applyApprovedVenueLocationDraft({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        approvalRequestId: operationId,
        expectedDecisionAt: revision,
        reason: 'Should not apply cross-scope evidence.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.locationCreate).not.toHaveBeenCalled()
  })

  it('creates and corrects an inactive floor draft with exact replay and audit evidence', async () => {
    const caller = app.createCaller(context())
    const input = {
      operationId: floor.id,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      stableKey: floor.stableKey,
      name: floor.name,
      level: floor.level,
      sortOrder: floor.sortOrder,
      mapImageUrl: floor.mapImageUrl,
    }
    await expect(caller.admin.createVenueFloorDraft(input)).resolves.toMatchObject({
      floor: { id: floor.id, isActive: false },
      replayed: false,
    })
    expect(mocks.floorCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: floor.id, isActive: false }) }),
    )
    mocks.floorFind.mockResolvedValueOnce(floor)
    await expect(caller.admin.createVenueFloorDraft(input)).resolves.toMatchObject({
      replayed: true,
    })

    mocks.floorFind.mockResolvedValueOnce(floor)
    const floorUpdateFields = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      stableKey: input.stableKey,
      name: input.name,
      level: input.level,
      sortOrder: input.sortOrder,
      mapImageUrl: input.mapImageUrl,
    }
    await expect(
      caller.admin.updateVenueFloorDraft({
        ...floorUpdateFields,
        floorId: floor.id,
        expectedUpdatedAt: revision,
        name: 'Main level',
        reason: 'Matched the current public floor map.',
      }),
    ).resolves.toEqual({ updatedAt: expect.any(Date) })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-floor.draft-updated' }),
      transactionClient,
    )
  })

  it('will not deactivate a floor while an active anchor still depends on it', async () => {
    mocks.floorFind.mockResolvedValue({ ...floor, isActive: true })
    mocks.locationFind.mockResolvedValue({ id: operationId })
    await expect(
      app.createCaller(context()).admin.setVenueFloorAvailability({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        floorId: floor.id,
        expectedUpdatedAt: revision,
        active: false,
        reason: 'Retiring an obsolete floor.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.floorUpdateMany).not.toHaveBeenCalled()
  })

  it('creates and corrects an inactive connection draft, then activates only active endpoints', async () => {
    const caller = app.createCaller(context())
    const input = {
      operationId: connection.id,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      fromLocationId: connection.fromLocationId,
      toLocationId: connection.toLocationId,
      kind: 'WALKWAY' as const,
      bidirectional: true,
      accessible: true,
      directions: connection.directions,
    }
    mocks.locationFind.mockResolvedValue({ id: operationId })
    await expect(caller.admin.createVenueLocationConnectionDraft(input)).resolves.toMatchObject({
      connection: { id: connection.id, isActive: false },
      replayed: false,
    })
    expect(mocks.connectionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: connection.id, isActive: false }),
      }),
    )

    mocks.connectionFind.mockResolvedValueOnce(connection)
    const connectionUpdateFields = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      kind: input.kind,
      bidirectional: input.bidirectional,
      accessible: input.accessible,
      directions: input.directions,
    }
    await expect(
      caller.admin.updateVenueLocationConnectionDraft({
        ...connectionUpdateFields,
        connectionId: connection.id,
        expectedUpdatedAt: revision,
        directions: 'Use the clearly marked level route.',
        reason: 'Corrected against the current accessibility map.',
      }),
    ).resolves.toEqual({ updatedAt: expect.any(Date) })

    mocks.connectionFind.mockResolvedValueOnce(connection)
    await expect(
      caller.admin.setVenueLocationConnectionAvailability({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        connectionId: connection.id,
        expectedUpdatedAt: revision,
        active: true,
        reason: 'Both anchors and the level route were verified.',
      }),
    ).resolves.toMatchObject({ connection: { isActive: true }, replayed: false })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-location-connection.activated' }),
      transactionClient,
    )
  })

  it('rejects self-connections and inactive endpoint activation', async () => {
    const caller = app.createCaller(context())
    await expect(
      caller.admin.createVenueLocationConnectionDraft({
        operationId: connection.id,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        fromLocationId: operationId,
        toLocationId: operationId,
        kind: 'DOOR',
        bidirectional: true,
        accessible: false,
        directions: null,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    mocks.connectionFind.mockResolvedValue(connection)
    mocks.locationFind.mockResolvedValueOnce({ id: operationId }).mockResolvedValueOnce(null)
    await expect(
      caller.admin.setVenueLocationConnectionAvailability({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        connectionId: connection.id,
        expectedUpdatedAt: revision,
        active: true,
        reason: 'Attempt with an inactive endpoint.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('will not deactivate an anchor while active child or connection topology depends on it', async () => {
    mocks.locationFind
      .mockResolvedValueOnce({ ...location, isActive: true })
      .mockResolvedValueOnce(null)
    mocks.connectionFind.mockResolvedValue({ id: connection.id })
    await expect(
      app.createCaller(context()).admin.setVenueLocationAvailability({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        locationId: operationId,
        expectedUpdatedAt: revision,
        active: false,
        reason: 'Attempting to retire an anchor.',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.locationUpdateMany).not.toHaveBeenCalled()
  })
})
