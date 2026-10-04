import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SourceConnectionConfigSchema,
  type SourceConnectionConfig,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'
import {
  approveSourceConnectionPreviewAction,
  claimSourceConnectionPollSlot,
  claimSourceConnectionRequest,
  createSourceConnectionDraftAction,
  recordSourceConnectionBytes,
  recordSourceConnectionPollFailure,
  recordSourceConnectionPreviewAction,
  setSourceConnectionStateAction,
  sourceConnectionPreviewHash,
  updateSourceConnectionDraftAction,
} from './source-connections'

const now = new Date('2026-10-03T20:00:00Z')
const scope = {
  tenantId: 'tenant_fixture',
  venueId: 'venue_fixture',
  connectorId: 'connector_fixture',
}
const actor = { actorId: 'human_fixture', actorRole: 'OWNER' as const }
function config(overrides: Partial<SourceConnectionConfig> = {}) {
  return SourceConnectionConfigSchema.parse({
    version: 1,
    sourceUrl: 'https://source.example.org/feed',
    allowedUrls: ['https://source.example.org/feed'],
    mappings: [
      {
        type: 'json_feed',
        kind: 'description',
        itemsPointer: '/items',
        idPointer: '/id',
        titlePointer: '/title',
        textPointer: '/text',
        dateFormat: 'iso',
      },
    ],
    timezone: 'America/Chicago',
    refreshIntervalSeconds: 300,
    freshnessSeconds: 3600,
    validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.25, maxRequestsPerDay: 2 },
    publicationPolicy: 'auto_verified',
    ...overrides,
  })
}
function harness(mapping = config()) {
  let row: Record<string, unknown> | null = {
    id: scope.connectorId,
    ...scope,
    mapping,
    provider: 'source_connection_v1',
    lastTestPreview: {},
    state: 'ACTIVE',
    updatedAt: new Date(now),
    nextPollAt: null,
    lastAttemptAt: null,
    pollIntervalSeconds: 300,
  }
  let nextId = 0
  const matches = (where: Record<string, unknown>) =>
    Boolean(
      row &&
      Object.entries(where).every(([key, value]) =>
        value instanceof Date
          ? row![key] instanceof Date && (row![key] as Date).getTime() === value.getTime()
          : row![key] === value,
      ),
    )
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    liveDataConnector: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? structuredClone(row) : null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          if (!matches(where)) return { count: 0 }
          row = { ...row, ...data }
          return { count: 1 }
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { id: scope.connectorId, updatedAt: new Date(now), ...data }
        return row
      }),
      count: vi.fn().mockResolvedValue(0),
    },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: scope.venueId }) },
    venueWebsiteOrigin: {
      findMany: vi.fn().mockResolvedValue([{ origin: 'https://source.example.org' }]),
    },
    venueSource: { create: vi.fn(async () => ({ id: `evidence_${++nextId}` })) },
    venueSourceInput: { create: vi.fn().mockResolvedValue({ id: 'input_fixture' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_fixture' }) },
  }
  const client = {
    ...tx,
    $transaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
  }
  return {
    tx,
    client: client as never,
    row: () => row!,
    set: (values: Record<string, unknown>) => {
      row = { ...row, ...values }
    },
  }
}
beforeEach(() => {
  process.env.NODE_ENV = 'test'
  process.env.LIVE_DATA_ALLOWED_HOSTS = 'source.example.org'
})

describe('source connection scope, approval and budget', () => {
  it('atomically counts concurrent HTTP attempts and refuses attempts over the daily budget', async () => {
    const h = harness()
    const expectedConfigHash = sourceConnectionConfigHash(config())
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimSourceConnectionRequest({ ...scope, expectedConfigHash, now }, h.client),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(2)
    expect((h.row().lastTestPreview as { usage: { requests: number } }).usage.requests).toBe(2)
    await recordSourceConnectionBytes({ ...scope, now, bytes: 17 }, h.client)
    expect(h.row().lastTestPreview).toMatchObject({
      usage: { requests: 2, bytes: 17, llmTokens: 0, llmCostUsd: 0, networkCost: 'unpriced' },
    })
    expect(
      await claimSourceConnectionRequest(
        { ...scope, expectedConfigHash, now: new Date('2026-10-04T00:00:01Z') },
        h.client,
      ),
    ).toBe(true)
    expect(h.row().lastTestPreview).toMatchObject({
      usage: { requests: 1, bytes: 0, day: '2026-10-04' },
    })
  })
  it('preserves daily budget through a disabled draft edit while invalidating preview and cache', async () => {
    const h = harness()
    h.set({
      state: 'DISABLED',
      lastTestPreview: {
        previewId: 'old',
        cache: { etag: 'old' },
        usage: { day: '2026-10-03', requests: 2, bytes: 23 },
      },
    })
    const next = config({ refreshIntervalSeconds: 600 })
    await updateSourceConnectionDraftAction(
      { ...scope, ...actor, config: next, expectedUpdatedAt: now.toISOString() },
      h.client,
    )
    expect(h.row().lastTestPreview).toEqual({
      usage: { day: '2026-10-03', requests: 2, bytes: 23 },
    })
    expect(
      await claimSourceConnectionRequest(
        { ...scope, previewOnly: true, now, expectedConfigHash: sourceConnectionConfigHash(next) },
        h.client,
      ),
    ).toBe(false)
    expect(h.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'HUMAN',
          actorRole: 'OWNER',
          action: 'source_connection.draft_updated',
        }),
      }),
    )
  })
  it('fences tenant, venue, paused state and changed config before another HTTP request', async () => {
    const h = harness()
    const input = { ...scope, now, expectedConfigHash: sourceConnectionConfigHash(config()) }
    expect(await claimSourceConnectionRequest({ ...input, tenantId: 'other' }, h.client)).toBe(
      false,
    )
    expect(await claimSourceConnectionRequest({ ...input, venueId: 'other' }, h.client)).toBe(false)
    expect(
      await claimSourceConnectionRequest(
        { ...input, expectedConfigHash: 'a'.repeat(64) },
        h.client,
      ),
    ).toBe(false)
    h.set({ state: 'DISABLED' })
    expect(await claimSourceConnectionRequest(input, h.client)).toBe(false)
    expect(await claimSourceConnectionRequest({ ...input, previewOnly: true }, h.client)).toBe(true)
  })
  it('shares a cooldown and version fence between manual and scheduled refreshes', async () => {
    const approved = config()
    const hash = sourceConnectionConfigHash(approved)
    approved.approval = {
      approvedConfigHash: hash,
      approvedPreviewHash: 'b'.repeat(64),
      approvedBy: actor.actorId,
      approvedAt: now.toISOString(),
    }
    const h = harness(approved)
    const input = { ...scope, expectedConfigHash: hash, now }
    const results = await Promise.all([
      claimSourceConnectionPollSlot({ ...input, mode: 'manual' }, h.client),
      claimSourceConnectionPollSlot({ ...input, mode: 'scheduled' }, h.client),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(
      await claimSourceConnectionPollSlot(
        { ...input, mode: 'manual', now: new Date(now.getTime() + 299_999) },
        h.client,
      ),
    ).toBe(false)
    expect(
      await claimSourceConnectionPollSlot(
        { ...input, mode: 'manual', now: new Date(now.getTime() + 300_000) },
        h.client,
      ),
    ).toBe(true)
  })
  it('records preview evidence without changing schedule or observations and preserves usage', async () => {
    const h = harness()
    h.set({
      state: 'DISABLED',
      lastTestPreview: {
        usage: { day: '2026-10-03', requests: 1, bytes: 9 },
        cache: { configHash: sourceConnectionConfigHash(config()), etag: 'tag' },
      },
    })
    const body = {
      configHash: sourceConnectionConfigHash(config()),
      contentHash: sourceConnectionSnapshotHash([]),
      records: [],
      issues: ['missing_records'],
      status: 'REVIEW_REQUIRED' as const,
      observedAt: now.toISOString(),
      cost: { fetches: 1, bytes: 9 },
    }
    await recordSourceConnectionPreviewAction(
      { ...scope, expectedConfigHash: body.configHash, preview: body, now },
      h.client,
    )
    expect(h.row().state).toBe('DISABLED')
    expect(h.row().nextPollAt).toBeNull()
    expect(h.row().lastTestPreview).toMatchObject({
      usage: { requests: 1, bytes: 9 },
      cache: { etag: 'tag' },
    })
    expect(h.tx.venueSourceInput.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          disposition: 'FAILED',
          textTruncated: false,
        }),
      }),
    )
  })
  it('refuses forged, stale or edited approval receipts and requires real manager authority', async () => {
    const h = harness()
    const body = {
      configHash: sourceConnectionConfigHash(config()),
      contentHash: sourceConnectionSnapshotHash([]),
      records: [],
      issues: [],
      status: 'VALID' as const,
      observedAt: now.toISOString(),
      cost: { fetches: 1, bytes: 9 },
    }
    const receipt = {
      ...body,
      previewId: 'preview_fixture',
      previewHash: sourceConnectionPreviewHash(body),
    }
    h.set({ lastTestPreview: { ...receipt, contentHash: 'a'.repeat(64) } })
    const input = {
      ...scope,
      ...actor,
      expectedUpdatedAt: now.toISOString(),
      previewId: receipt.previewId,
      previewHash: receipt.previewHash,
      now,
    }
    await expect(approveSourceConnectionPreviewAction(input, h.client)).rejects.toThrow(
      'Exact valid preview',
    )
    h.set({ lastTestPreview: receipt })
    await expect(
      approveSourceConnectionPreviewAction(
        { ...input, now: new Date(now.getTime() + 3_600_000) },
        h.client,
      ),
    ).rejects.toThrow('current source preview')
    await expect(
      approveSourceConnectionPreviewAction({ ...input, actorRole: 'STAFF' as never }, h.client),
    ).rejects.toThrow('Verified manager')
    await approveSourceConnectionPreviewAction(input, h.client)
    expect(h.row().mapping).toMatchObject({ approval: { approvedConfigHash: body.configHash } })
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1)
  })
  it('does not record stale failures after pause or config edits', async () => {
    const h = harness()
    const input = {
      ...scope,
      now,
      nextPollAt: new Date(now.getTime() + 300_000),
      expectedConfigHash: sourceConnectionConfigHash(config()),
      errorCategory: 'network_error',
    }
    h.set({ state: 'DISABLED' })
    expect(await recordSourceConnectionPollFailure(input, h.client)).toBe(false)
    h.set({ state: 'ACTIVE', mapping: config({ refreshIntervalSeconds: 600 }) })
    expect(await recordSourceConnectionPollFailure(input, h.client)).toBe(false)
    expect(h.tx.venueSourceInput.create).not.toHaveBeenCalled()
  })
  it('checks shared connector limits in the creation transaction and rejects unapproved resume', async () => {
    const h = harness()
    h.set({ resourceId: 'other' })
    h.tx.liveDataConnector.count.mockResolvedValue(20)
    await expect(
      createSourceConnectionDraftAction(
        {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          name: 'Fixture source',
          config: config(),
          ...actor,
        },
        h.client,
      ),
    ).rejects.toThrow('connector limit')
    expect(h.tx.$executeRaw).toHaveBeenCalled()
    expect(h.tx.liveDataConnector.create).not.toHaveBeenCalled()
    await expect(
      setSourceConnectionStateAction(
        { ...scope, ...actor, expectedUpdatedAt: now.toISOString(), now, state: 'ACTIVE' },
        h.client,
      ),
    ).rejects.toThrow('matching approval')
  })
})
