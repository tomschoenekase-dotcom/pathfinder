import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  approve: vi.fn(),
  setState: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
}))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  createSourceConnectionDraftAction: mocks.create,
  updateSourceConnectionDraftAction: mocks.update,
  approveSourceConnectionPreviewAction: mocks.approve,
  setSourceConnectionStateAction: mocks.setState,
  writeAuditLogStrict: mocks.audit,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueLiveDataPoll: mocks.enqueue }))

import type { TenantRole } from '@pathfinder/auth'
import { sourceConnectionConfigHash } from '@pathfinder/contracts/source-connections-node'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { sourceConnectionsRouter } from './source-connections'

const TENANT = 'tenant_a'
const VENUE = 'venue_a'
const CONNECTOR = 'connector_a'
const UPDATED = new Date('2026-10-03T20:00:00.000Z')
const config = {
  version: 1 as const,
  sourceUrl: 'https://example.org/source',
  allowedUrls: ['https://example.org/source'],
  mappings: [
    {
      type: 'html' as const,
      kind: 'event' as const,
      recordSelector: 'article',
      id: { selector: 'h3', attribute: 'text' as const },
      title: { selector: 'h3', attribute: 'text' as const },
      text: { selector: 'p', attribute: 'text' as const },
      dateFormat: 'iso' as const,
      allowCrossMidnight: false,
    },
  ],
  timezone: 'America/Chicago',
  refreshIntervalSeconds: 3600,
  freshnessSeconds: 3600,
  validation: { minRecords: 1, maxRecords: 50, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'review_required' as const,
}
const testRouter = router({ sourceConnections: sourceConnectionsRouter })

function makeDb() {
  const row = {
    id: CONNECTOR,
    name: 'Public feed',
    venueId: VENUE,
    endpointHost: 'example.org',
    mapping: config,
    state: 'DISABLED',
    updatedAt: UPDATED,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCategory: null,
    consecutiveFailures: 0,
    lastTestAt: null,
    lastTestOutcome: null,
    lastTestErrorCategory: null,
    lastTestPreview: null,
    observation: null,
  }
  return {
    liveDataConnector: {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue(row),
    },
  }
}
function caller(role: TenantRole, database: ReturnType<typeof makeDb>, tenantId = TENANT) {
  const context: TRPCContext = {
    db: database as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'manager_a', activeTenantId: tenantId, role, isPlatformAdmin: false },
  }
  return testRouter.createCaller(context).sourceConnections
}

describe('source connections router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue({ id: CONNECTOR, updatedAt: UPDATED })
    mocks.update.mockResolvedValue({ id: CONNECTOR, updatedAt: UPDATED })
    mocks.approve.mockResolvedValue({ id: CONNECTOR, updatedAt: UPDATED })
    mocks.setState.mockResolvedValue({ id: CONNECTOR, updatedAt: UPDATED })
    mocks.audit.mockResolvedValue(undefined)
    mocks.enqueue.mockResolvedValue(undefined)
  })

  it('scopes list and get to authenticated tenant, venue and source provider', async () => {
    const database = makeDb()
    await caller('STAFF', database).list({ venueId: VENUE })
    expect(database.liveDataConnector.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, venueId: VENUE, provider: 'source_connection_v1' },
      }),
    )
    await caller('STAFF', database).get({ venueId: VENUE, connectorId: CONNECTOR })
    expect(database.liveDataConnector.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CONNECTOR,
          tenantId: TENANT,
          venueId: VENUE,
          provider: 'source_connection_v1',
        },
      }),
    )
    database.liveDataConnector.findFirst.mockResolvedValueOnce(null)
    await expect(
      caller('STAFF', database).get({ venueId: 'other_venue', connectorId: CONNECTOR }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('requires manager authority and derives tenant and actor for draft creation', async () => {
    const database = makeDb()
    const input = { venueId: VENUE, name: 'Public feed', config }
    await expect(caller('STAFF', database).createDraft(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.create).not.toHaveBeenCalled()
    await caller('MANAGER', database).createDraft(input)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        venueId: VENUE,
        actorId: 'manager_a',
        actorRole: 'MANAGER',
        config: expect.objectContaining({ sourceUrl: config.sourceUrl }),
      }),
      database,
    )
    await expect(
      caller('MANAGER', database).createDraft({ ...input, tenantId: 'victim' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('queues only an async preview for the exact current version', async () => {
    const database = makeDb()
    const input = {
      venueId: VENUE,
      connectorId: CONNECTOR,
      expectedUpdatedAt: UPDATED.toISOString(),
    }
    const result = await caller('MANAGER', database).requestPreview(input)
    expect(result).toMatchObject({ queued: true, configHash: sourceConnectionConfigHash(config) })
    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenantId: TENANT,
      venueId: VENUE,
      connectorId: CONNECTOR,
      mode: 'test',
    })
    await expect(
      caller('MANAGER', database).requestPreview({
        ...input,
        expectedUpdatedAt: new Date(UPDATED.getTime() - 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
  })

  it('passes exact preview identity and version into the canonical approval guard', async () => {
    const database = makeDb()
    const input = {
      venueId: VENUE,
      connectorId: CONNECTOR,
      expectedUpdatedAt: UPDATED.toISOString(),
      previewId: 'preview_a',
      previewHash: 'a'.repeat(64),
    }
    await caller('MANAGER', database).approvePreview(input)
    expect(mocks.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        venueId: VENUE,
        connectorId: CONNECTOR,
        expectedUpdatedAt: UPDATED.toISOString(),
        previewId: input.previewId,
        previewHash: input.previewHash,
      }),
      database,
    )
    mocks.approve.mockRejectedValueOnce(
      Object.assign(new Error('Stale preview'), { code: 'CONFLICT' }),
    )
    await expect(caller('MANAGER', database).approvePreview(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses manual refresh until active approval matches the exact configuration', async () => {
    const database = makeDb()
    const input = {
      venueId: VENUE,
      connectorId: CONNECTOR,
      expectedUpdatedAt: UPDATED.toISOString(),
    }
    await expect(caller('MANAGER', database).requestRefresh(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(mocks.enqueue).not.toHaveBeenCalled()
    database.liveDataConnector.findFirst.mockResolvedValueOnce({
      ...(await database.liveDataConnector.findFirst()),
      state: 'ACTIVE',
      mapping: {
        ...config,
        approval: {
          approvedConfigHash: sourceConnectionConfigHash(config),
          approvedPreviewHash: 'a'.repeat(64),
          approvedAt: UPDATED.toISOString(),
          approvedBy: 'manager_a',
        },
      },
    })
    await caller('MANAGER', database).requestRefresh(input)
    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenantId: TENANT,
      venueId: VENUE,
      connectorId: CONNECTOR,
      mode: 'manual',
    })
  })
})
