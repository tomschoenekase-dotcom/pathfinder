import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writeAuditLogStrict: vi.fn(),
  lockVenueContentMutation: vi.fn(),
  enqueueLiveDataPoll: vi.fn(),
  isFeatureEnabled: vi.fn(() => false),
}))

vi.mock('@pathfinder/db', () => ({
  writeAuditLogStrict: mocks.writeAuditLogStrict,
  lockVenueContentMutation: mocks.lockVenueContentMutation,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueLiveDataPoll: mocks.enqueueLiveDataPoll }))
vi.mock('@pathfinder/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/config')>()),
  isFeatureEnabled: mocks.isFeatureEnabled,
}))

import type { TenantRole } from '@pathfinder/auth'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { liveDataRouter } from './live-data'

const TENANT = 'tenant_a'
const VENUE = 'cvenueabc123456789012'
const CONNECTOR = 'cconnector12345678901'

const testRouter = router({ liveData: liveDataRouter })

const sportsMapping = {
  observedAt: { pointer: '/updated', format: 'iso8601' as const },
  fields: {
    homeScore: { pointer: '/home', type: 'integer' as const },
    awayScore: { pointer: '/away', type: 'integer' as const },
  },
}

const createInput = {
  venueId: VENUE,
  name: 'Home game score',
  kind: 'sports_score' as const,
  provider: 'fixture-sports',
  resourceId: 'game.home',
  resourceLabel: 'Hawks home game',
  endpointUrl: 'https://feeds.example-sports.com/v1/game',
  mapping: sportsMapping,
  pollIntervalSeconds: 60,
  freshnessBudgetSeconds: 180,
  timezone: 'America/New_York',
}

function makeDb() {
  const tx = {
    liveDataConnector: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'conn_new' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    liveDataObservation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  const db = {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: VENUE }) },
    liveDataConnector: {
      count: tx.liveDataConnector.count,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({
        id: CONNECTOR,
        venueId: VENUE,
        kind: 'SPORTS_SCORE',
        state: 'ACTIVE',
        mapping: sportsMapping,
        endpointUrl: 'https://feeds.example-sports.com/v1/game',
        pollIntervalSeconds: 60,
        freshnessBudgetSeconds: 180,
        lastTestAt: null,
      }),
    },
    tenantFeatureFlag: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  }
  return { db, tx }
}

function caller(role: TenantRole, db: unknown) {
  const context: TRPCContext = {
    db: db as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'user_1', activeTenantId: TENANT, role, isPlatformAdmin: false },
  }
  return testRouter.createCaller(context)
}

describe('liveData router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    mocks.writeAuditLogStrict.mockResolvedValue(undefined)
    mocks.enqueueLiveDataPoll.mockResolvedValue(undefined)
    mocks.isFeatureEnabled.mockReturnValue(false)
  })

  describe('create', () => {
    it('reserves the source connection provider for the review workflow', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.create({ ...createInput, provider: 'source_connection_v1' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(db.liveDataConnector.findFirst).not.toHaveBeenCalled()
    })
    it('forbids STAFF and writes nothing', async () => {
      const { db } = makeDb()
      await expect(caller('STAFF', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      expect(db.venue.findFirst).not.toHaveBeenCalled()
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('creates a DISABLED connector scoped to the session tenant and audits it', async () => {
      const { db, tx } = makeDb()
      const result = await caller('MANAGER', db).liveData.create(createInput)
      expect(result).toEqual({ id: 'conn_new' })
      expect(db.venue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VENUE, tenantId: TENANT } }),
      )
      expect(mocks.lockVenueContentMutation).toHaveBeenCalledWith(tx, {
        tenantId: TENANT,
        venueId: 'live-data-connector-capacity',
      })
      expect(tx.liveDataConnector.count).toHaveBeenCalledWith({ where: { tenantId: TENANT } })
      expect(tx.liveDataConnector.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT,
            venueId: VENUE,
            state: 'DISABLED',
            kind: 'SPORTS_SCORE',
            endpointHost: 'feeds.example-sports.com',
            createdBy: 'user_1',
          }),
        }),
      )
      expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          actorId: 'user_1',
          action: 'live-data-connector.created',
          targetType: 'LiveDataConnector',
          targetId: 'conn_new',
        }),
        tx,
      )
      // The audit trail records the host, never the full URL or any provider data.
      expect(JSON.stringify(mocks.writeAuditLogStrict.mock.calls)).not.toContain('/v1/game')
    })

    it('never accepts tenant authority from the request', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.create({
          ...createInput,
          tenantId: 'tenant_victim',
        } as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('returns NOT_FOUND for a venue outside the tenant', async () => {
      const { db } = makeDb()
      db.venue.findFirst.mockResolvedValue(null)
      await expect(caller('MANAGER', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it.each([
      'http://feeds.example-sports.com/v1/game',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/x',
      'https://metadata.internal/x',
      'https://user:pass@feeds.example-sports.com/x',
      'https://feeds.example-sports.com/x?api_key=sk_live_123',
    ])('rejects the unsafe endpoint %s', async (endpointUrl) => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.create({ ...createInput, endpointUrl }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('fails closed in production until the platform allowlist names the host', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const { db } = makeDb()
      await expect(caller('MANAGER', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('allowlist'),
      })
      vi.stubEnv('LIVE_DATA_ALLOWED_HOSTS', '*.example-sports.com')
      await expect(caller('MANAGER', db).liveData.create(createInput)).resolves.toEqual({
        id: 'conn_new',
      })
    })

    it('rejects a mapping that does not satisfy the connector kind', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.create({
          ...createInput,
          kind: 'ride_status',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('status') })
    })

    it('rejects a freshness budget shorter than the poll interval', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.create({
          ...createInput,
          pollIntervalSeconds: 300,
          freshnessBudgetSeconds: 60,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('maps a duplicate resource to CONFLICT', async () => {
      const { db, tx } = makeDb()
      tx.liveDataConnector.create.mockRejectedValue(
        Object.assign(new Error('dup'), { code: 'P2002' }),
      )
      await expect(caller('MANAGER', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'CONFLICT',
      })
    })

    it('enforces the per-tenant connector cap inside the capacity lock', async () => {
      const { db, tx } = makeDb()
      tx.liveDataConnector.count.mockResolvedValueOnce(0).mockResolvedValueOnce(100)
      await expect(caller('MANAGER', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
      expect(mocks.lockVenueContentMutation).toHaveBeenCalledWith(tx, {
        tenantId: TENANT,
        venueId: 'live-data-connector-capacity',
      })
      expect(tx.liveDataConnector.create).not.toHaveBeenCalled()
    })

    it('enforces the per-venue connector cap', async () => {
      const { db } = makeDb()
      db.liveDataConnector.count.mockResolvedValue(20)
      await expect(caller('MANAGER', db).liveData.create(createInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    })
  })

  describe('cross-tenant connector IDs', () => {
    it.each(['update', 'enable', 'disable', 'test'] as const)(
      '%s returns NOT_FOUND and changes nothing when the connector belongs to another tenant',
      async (name) => {
        const { db, tx } = makeDb()
        db.liveDataConnector.findFirst.mockResolvedValue(null)
        const input =
          name === 'update'
            ? { connectorId: CONNECTOR, name: 'Hijack' }
            : { connectorId: CONNECTOR }
        await expect(
          (caller('MANAGER', db).liveData[name] as (value: unknown) => Promise<unknown>)(input),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
        expect(db.liveDataConnector.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: CONNECTOR, tenantId: TENANT } }),
        )
        expect(tx.liveDataConnector.updateMany).not.toHaveBeenCalled()
        expect(mocks.writeAuditLogStrict).not.toHaveBeenCalled()
        expect(mocks.enqueueLiveDataPoll).not.toHaveBeenCalled()
      },
    )
  })

  describe('update', () => {
    it('blocks legacy edits and provider spoofing of source connections', async () => {
      const { db, tx } = makeDb()
      db.liveDataConnector.findFirst.mockResolvedValueOnce({
        id: CONNECTOR,
        venueId: VENUE,
        provider: 'source_connection_v1',
      })
      await expect(
        caller('MANAGER', db).liveData.update({ connectorId: CONNECTOR, name: 'Changed' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(
        caller('MANAGER', db).liveData.update({
          connectorId: CONNECTOR,
          provider: 'source_connection_v1',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(tx.liveDataConnector.updateMany).not.toHaveBeenCalled()
    })
    it('clears the stored observation when the mapping changes and audits the change', async () => {
      const { db, tx } = makeDb()
      await caller('MANAGER', db).liveData.update({
        connectorId: CONNECTOR,
        mapping: sportsMapping,
        resourceLabel: 'Renamed',
      })
      expect(tx.liveDataConnector.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONNECTOR, tenantId: TENANT },
          data: expect.objectContaining({ nextPollAt: null, updatedBy: 'user_1' }),
        }),
      )
      expect(tx.liveDataObservation.deleteMany).toHaveBeenCalledWith({
        where: { connectorId: CONNECTOR, tenantId: TENANT },
      })
      expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'live-data-connector.updated', targetId: CONNECTOR }),
        tx,
      )
    })

    it('keeps the observation for a label-only edit', async () => {
      const { db, tx } = makeDb()
      await caller('MANAGER', db).liveData.update({ connectorId: CONNECTOR, name: 'New name' })
      expect(tx.liveDataObservation.deleteMany).not.toHaveBeenCalled()
    })

    it('validates a replacement endpoint', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.update({
          connectorId: CONNECTOR,
          endpointUrl: 'https://10.0.0.1/x',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })
  })

  describe('enable / disable', () => {
    it.each(['enable', 'disable', 'test'] as const)(
      'blocks legacy %s for source connections',
      async (name) => {
        const { db, tx } = makeDb()
        db.liveDataConnector.findFirst.mockResolvedValue({
          id: CONNECTOR,
          venueId: VENUE,
          provider: 'source_connection_v1',
        })
        await expect(
          caller('MANAGER', db).liveData[name]({ connectorId: CONNECTOR }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(tx.liveDataConnector.updateMany).not.toHaveBeenCalled()
        expect(mocks.enqueueLiveDataPoll).not.toHaveBeenCalled()
      },
    )
    it('disable stops scheduling, is tenant fenced, and is audited', async () => {
      const { db, tx } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.disable({ connectorId: CONNECTOR }),
      ).resolves.toEqual({
        id: CONNECTOR,
        enabled: false,
      })
      expect(tx.liveDataConnector.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONNECTOR, tenantId: TENANT },
          data: expect.objectContaining({ state: 'DISABLED', nextPollAt: null }),
        }),
      )
      expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'live-data-connector.disabled',
          beforeState: { enabled: true },
          afterState: expect.objectContaining({ enabled: false }),
        }),
        tx,
      )
    })

    it('enable activates and audits; STAFF cannot enable or disable', async () => {
      const { db, tx } = makeDb()
      await caller('OWNER', db).liveData.enable({ connectorId: CONNECTOR })
      expect(tx.liveDataConnector.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'ACTIVE' }) }),
      )
      expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'live-data-connector.enabled' }),
        tx,
      )
      for (const name of ['enable', 'disable'] as const) {
        await expect(
          caller('STAFF', db).liveData[name]({ connectorId: CONNECTOR }),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
        })
      }
    })
  })

  describe('test', () => {
    it('queues a worker test with the session tenant and never fetches inline', async () => {
      const { db } = makeDb()
      await expect(
        caller('MANAGER', db).liveData.test({ connectorId: CONNECTOR }),
      ).resolves.toEqual({
        id: CONNECTOR,
        queued: true,
      })
      expect(mocks.enqueueLiveDataPoll).toHaveBeenCalledWith(
        { tenantId: TENANT, venueId: VENUE, connectorId: CONNECTOR, mode: 'test' },
        expect.any(Date),
      )
      expect(mocks.writeAuditLogStrict).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'live-data-connector.test-requested' }),
        db,
      )
    })

    it('rate limits repeated tests of one connector', async () => {
      const { db } = makeDb()
      db.liveDataConnector.findFirst.mockResolvedValue({
        id: CONNECTOR,
        venueId: VENUE,
        lastTestAt: new Date(Date.now() - 5_000),
      })
      await expect(
        caller('MANAGER', db).liveData.test({ connectorId: CONNECTOR }),
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      })
      expect(mocks.enqueueLiveDataPoll).not.toHaveBeenCalled()
    })
  })

  describe('list and policy', () => {
    it('lists tenant+venue scoped connectors with live state and no secret-bearing fields', async () => {
      const { db } = makeDb()
      const now = new Date()
      db.liveDataConnector.findMany.mockResolvedValue([
        {
          id: CONNECTOR,
          venueId: VENUE,
          name: 'Home game score',
          kind: 'SPORTS_SCORE',
          provider: 'fixture-sports',
          resourceId: 'game.home',
          resourceLabel: 'Hawks home game',
          endpointUrl: 'https://feeds.example-sports.com/v1/game',
          endpointHost: 'feeds.example-sports.com',
          mapping: sportsMapping,
          pollIntervalSeconds: 60,
          freshnessBudgetSeconds: 180,
          timezone: 'America/New_York',
          state: 'ACTIVE',
          lastAttemptAt: now,
          lastSuccessAt: now,
          lastErrorCategory: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
          lastTestAt: now,
          lastTestOutcome: 'OK',
          lastTestErrorCategory: null,
          lastTestPreview: { state: 'fresh' },
          updatedAt: now,
          observation: {
            values: {
              homeScore: { type: 'integer', value: 3 },
              awayScore: { type: 'integer', value: 0 },
            },
            observedAt: new Date(now.getTime() - 10_000),
            fetchedAt: now,
            timestampBasis: 'provider',
            conflicts: [],
          },
        },
      ])
      const rows = await caller('STAFF', db).liveData.list({ venueId: VENUE })
      expect(db.liveDataConnector.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT, venueId: VENUE, provider: { not: 'source_connection_v1' } },
        }),
      )
      expect(rows[0]).toMatchObject({
        kind: 'sports_score',
        enabled: true,
        liveState: 'fresh',
        lastTest: { outcome: 'OK' },
      })
      expect(JSON.stringify(rows)).not.toMatch(/secret|token|password|apiKey/iu)
    })

    it('exposes the three knowledge concepts with open web off', async () => {
      const { db } = makeDb()
      db.liveDataConnector.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2)
      const policy = await caller('STAFF', db).liveData.policy({ venueId: VENUE })
      expect(policy.openWeb).toEqual({
        enabled: false,
        enablement: 'PLATFORM_ADMIN_ONLY',
        implemented: false,
      })
      expect(policy.generalKnowledge.mode).toBe('APPROVED_VENUE_ONLY')
      expect(policy.liveConnectors).toEqual({ activeCount: 2, totalCount: 3 })
      expect(policy.customerWording).toContain('does not freely browse the public web')
    })
  })
})
