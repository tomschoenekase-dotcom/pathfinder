import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SourceConnectionConfigSchema,
  type SourceConnectionRecord,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'

const mocks = vi.hoisted(() => ({
  ActionError: class SourceConnectionActionError extends Error {
    constructor(public readonly code: string) {
      super('refused')
    }
  },
  claimPoll: vi.fn(),
  claimRequest: vi.fn(),
  publish: vi.fn(),
  failure: vi.fn(),
  bytes: vi.fn(),
  cache: vi.fn(),
  preview: vi.fn(),
  diagnostic: vi.fn(),
  validate: vi.fn(),
  prior: vi.fn(),
  extract: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({
  claimSourceConnectionPollSlot: mocks.claimPoll,
  claimSourceConnectionRequest: mocks.claimRequest,
  publishSourceConnectionSnapshot: mocks.publish,
  recordSourceConnectionPollFailure: mocks.failure,
  recordSourceConnectionBytes: mocks.bytes,
  recordSourceConnectionCache: mocks.cache,
  recordSourceConnectionPreviewAction: mocks.preview,
  recordSourceConnectionDiagnostic: mocks.diagnostic,
  validateSourceConnectionConfig: mocks.validate,
  SourceConnectionActionError: mocks.ActionError,
  db: { liveDataObservation: { findFirst: mocks.prior } },
}))
vi.mock('../lib/source-connection-extract', () => ({ extractSourceConnection: mocks.extract }))
import { processSourceConnectionPoll } from './source-connection-poll'
import type { SourceConnectionFetchOutcome } from '../lib/source-connection-fetch'

const now = new Date('2026-10-03T20:00:00Z')
const record: SourceConnectionRecord = {
  id: 'fixture_record',
  kind: 'event',
  title: 'Fixture event',
  text: 'A scheduled fixture.',
  sourceUrl: 'https://source.example.org/feed',
  startDate: '2026-10-03',
  endDate: '2026-10-03',
  showtimes: [],
  effectiveFrom: '2026-10-03T05:00:00Z',
  effectiveUntil: '2026-10-04T05:00:00Z',
  timezone: 'America/Chicago',
  cancelled: false,
  exceptions: [],
  links: [],
}
function fixture() {
  const config = SourceConnectionConfigSchema.parse({
    version: 1,
    sourceUrl: record.sourceUrl,
    allowedUrls: [record.sourceUrl],
    mappings: [
      {
        type: 'json_feed',
        kind: 'event',
        itemsPointer: '/items',
        idPointer: '/id',
        titlePointer: '/title',
        textPointer: '/text',
        dateFormat: 'iso',
      },
    ],
    timezone: record.timezone,
    refreshIntervalSeconds: 300,
    freshnessSeconds: 3600,
    validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.25, maxRequestsPerDay: 2 },
    publicationPolicy: 'auto_verified',
  })
  const configHash = sourceConnectionConfigHash(config)
  config.approval = {
    approvedConfigHash: configHash,
    approvedPreviewHash: 'b'.repeat(64),
    approvedAt: now.toISOString(),
    approvedBy: 'human_fixture',
  }
  const connector = {
    id: 'connector_fixture',
    tenantId: 'tenant_fixture',
    venueId: 'venue_fixture',
    kind: 'GENERIC_JSON',
    provider: 'source_connection_v1',
    resourceId: 'fixture',
    endpointUrl: record.sourceUrl,
    endpointHost: 'source.example.org',
    mapping: config,
    lastTestPreview: {
      cache: {
        configHash,
        contentHash: sourceConnectionSnapshotHash([record]),
        etag: 'cached_tag',
      },
    },
    pollIntervalSeconds: 300,
    freshnessBudgetSeconds: 3600,
    state: 'ACTIVE',
    nextPollAt: null,
    consecutiveFailures: 0,
  }
  const payload = {
    tenantId: connector.tenantId,
    venueId: connector.venueId,
    connectorId: connector.id,
    mode: 'scheduled' as const,
  }
  const snapshot = {
    version: 1,
    configHash,
    contentHash: sourceConnectionSnapshotHash([record]),
    sourceUrl: record.sourceUrl,
    observedAt: new Date(now.getTime() - 600_000).toISOString(),
    freshnessExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
    validUntil: record.effectiveUntil,
    records: [record],
    publicationIds: [],
    cost: { fetches: 1, bytes: 42 },
  }
  return { config, connector: connector as never, payload, snapshot }
}
const fetched: SourceConnectionFetchOutcome = {
  status: 'fetched',
  body: Buffer.from('{}'),
  contentType: 'application/json',
  finalUrl: record.sourceUrl,
  requestCount: 1,
  bytesTransferred: 42,
  etag: 'new_tag',
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.claimPoll.mockResolvedValue(true)
  mocks.diagnostic.mockResolvedValue(true)
  mocks.failure.mockResolvedValue(true)
  mocks.claimRequest.mockResolvedValue(true)
  mocks.prior.mockResolvedValue(null)
  mocks.publish.mockResolvedValue({ status: 'PUBLISHED' })
  mocks.validate.mockResolvedValue(undefined)
  mocks.extract.mockReturnValue({ status: 'VALID', records: [record], issues: [] })
})

describe('source connection cached worker', () => {
  it('tests unconditionally and creates a preview without publishing or claiming a scheduled slot', async () => {
    const h = fixture()
    mocks.prior.mockResolvedValue({ values: h.snapshot })
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(async () => fetched)
    expect(
      await processSourceConnectionPoll({ ...h.payload, mode: 'test' }, h.connector, {
        now: () => now,
        fetch,
      }),
    ).toEqual({ outcome: 'preview-valid' })
    expect(fetch.mock.calls[0]?.[1]).toEqual({})
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.claimPoll).not.toHaveBeenCalled()
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConfigHash: h.snapshot.configHash,
        preview: expect.objectContaining({ cost: { fetches: 1, bytes: 42 } }),
      }),
    )
  })
  it('does not send preview validators before the first published snapshot exists', async () => {
    const h = fixture()
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(async () => fetched)
    await processSourceConnectionPoll(h.payload, h.connector, { now: () => now, fetch })
    expect(fetch.mock.calls[0]?.[1]).toEqual({})
    expect(mocks.publish).toHaveBeenCalledOnce()
  })
  it('renews cache freshness on a 304 without extending date-specific validity or republishing records', async () => {
    const h = fixture()
    mocks.prior.mockResolvedValue({ values: h.snapshot })
    mocks.publish.mockResolvedValue({ status: 'UNCHANGED' })
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(
      async () =>
        ({
          status: 'not_modified',
          finalUrl: record.sourceUrl,
          requestCount: 1,
          bytesTransferred: 0,
          etag: 'cached_tag',
        }) as SourceConnectionFetchOutcome,
    )
    expect(
      await processSourceConnectionPoll(h.payload, h.connector, { now: () => now, fetch }),
    ).toEqual({ outcome: 'unchanged' })
    expect(fetch.mock.calls[0]?.[1]).toEqual({ etag: 'cached_tag' })
    expect(mocks.extract).not.toHaveBeenCalled()
    expect(mocks.publish.mock.calls[0]?.[0].snapshot).toMatchObject({
      observedAt: now.toISOString(),
      freshnessExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      validUntil: record.effectiveUntil,
      records: [record],
    })
  })
  it('holds manual refresh duplicates, inactive configs and missing approval before any fetch', async () => {
    const h = fixture()
    mocks.claimPoll.mockResolvedValue(false)
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(async () => fetched)
    expect(
      await processSourceConnectionPoll({ ...h.payload, mode: 'manual' }, h.connector, {
        now: () => now,
        fetch,
      }),
    ).toEqual({ outcome: 'not-due' })
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.claimPoll).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual' }))
  })
  it('checks the durable budget immediately before HTTP and stores a fenced transport failure', async () => {
    const h = fixture()
    mocks.claimRequest.mockResolvedValue(false)
    const fetch = vi.fn(async (_config, _cache, dependencies) => {
      expect(await dependencies.beforeRequest()).toBe(false)
      return {
        status: 'failed',
        errorCategory: 'request_budget_exhausted',
        retryable: false,
        requestCount: 0,
        bytesTransferred: 0,
      } as SourceConnectionFetchOutcome
    })
    const result = await processSourceConnectionPoll(h.payload, h.connector, {
      now: () => now,
      fetch,
    })
    expect(result.errorCategory).toBe('request_budget_exhausted')
    expect(mocks.claimRequest).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConfigHash: h.snapshot.configHash, previewOnly: false }),
    )
    expect(mocks.failure).toHaveBeenCalledWith(
      expect.objectContaining({ expectedConfigHash: h.snapshot.configHash }),
    )
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it('records unusable 304 and publication conflicts as failures while keeping prior source dates', async () => {
    const h = fixture()
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(
      async () =>
        ({
          status: 'not_modified',
          finalUrl: record.sourceUrl,
          requestCount: 1,
          bytesTransferred: 0,
        }) as SourceConnectionFetchOutcome,
    )
    expect(
      (await processSourceConnectionPoll(h.payload, h.connector, { now: () => now, fetch }))
        .errorCategory,
    ).toBe('cache_invalid')
    expect(mocks.failure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'cache_invalid' }),
    )
    mocks.prior.mockResolvedValue({ values: h.snapshot })
    mocks.publish.mockResolvedValue({ status: 'CONFLICT' })
    expect(
      (await processSourceConnectionPoll(h.payload, h.connector, { now: () => now, fetch }))
        .errorCategory,
    ).toBe('publication_conflict')
    expect(mocks.failure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'publication_conflict' }),
    )
  })
  it('does not publish extraction issues and does not reuse cache from an old config', async () => {
    const h = fixture()
    mocks.prior.mockResolvedValue({ values: { ...h.snapshot, configHash: 'c'.repeat(64) } })
    mocks.extract.mockReturnValue({
      status: 'REVIEW_REQUIRED',
      records: [],
      issues: ['missing_year'],
    })
    const fetch = vi.fn<
      NonNullable<import('./source-connection-poll').SourceConnectionPollDependencies['fetch']>
    >(async () => fetched)
    expect(
      (await processSourceConnectionPoll(h.payload, h.connector, { now: () => now, fetch }))
        .outcome,
    ).toBe('review-required')
    expect(fetch.mock.calls[0]?.[1]).toEqual({})
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  describe('early failure diagnostics', () => {
    it('records invalid_config at connector level for scheduled and test runs', async () => {
      const h = fixture()
      const bad = { ...(h.connector as object), mapping: { version: 1 } } as never
      expect(await processSourceConnectionPoll(h.payload, bad, { now: () => now })).toEqual({
        outcome: 'invalid-config',
        errorCategory: 'invalid_config',
      })
      expect(mocks.diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCategory: 'invalid_config',
          preview: false,
          nextPollAt: new Date(now.getTime() + 300_000),
        }),
      )
      await processSourceConnectionPoll({ ...h.payload, mode: 'test' }, bad, { now: () => now })
      expect(mocks.diagnostic).toHaveBeenLastCalledWith(
        expect.objectContaining({ errorCategory: 'invalid_config', preview: true }),
      )
    })
    it('records origin_invalid only for validation refusals and rethrows other errors', async () => {
      const h = fixture()
      mocks.validate.mockRejectedValueOnce(new mocks.ActionError('INVALID_INPUT'))
      await processSourceConnectionPoll(h.payload, h.connector, { now: () => now })
      expect(mocks.failure).toHaveBeenCalledWith(
        expect.objectContaining({ errorCategory: 'origin_invalid' }),
      )
      mocks.validate.mockRejectedValueOnce(new Error('connection refused'))
      await expect(
        processSourceConnectionPoll(h.payload, h.connector, { now: () => now }),
      ).rejects.toThrow('connection refused')
      expect(mocks.diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ errorCategory: 'internal_error' }),
      )
      expect(mocks.failure).toHaveBeenCalledTimes(1)
    })
    it('records a REVIEW_REQUIRED preview for a refused origin in test mode', async () => {
      const h = fixture()
      mocks.validate.mockRejectedValueOnce(new mocks.ActionError('INVALID_INPUT'))
      await processSourceConnectionPoll({ ...h.payload, mode: 'test' }, h.connector, {
        now: () => now,
      })
      expect(mocks.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          preview: expect.objectContaining({
            status: 'REVIEW_REQUIRED',
            issues: ['origin_invalid'],
          }),
        }),
      )
    })
    it('records redirect_forbidden with the bytes already fetched', async () => {
      const h = fixture()
      const fetch = vi.fn(async () => ({
        ...fetched,
        finalUrl: 'https://elsewhere.example.org/feed',
      }))
      const result = await processSourceConnectionPoll(h.payload, h.connector, {
        now: () => now,
        fetch,
      })
      expect(result).toEqual({ outcome: 'forbidden-redirect', errorCategory: 'redirect_forbidden' })
      expect(mocks.bytes).toHaveBeenCalledWith(expect.objectContaining({ bytes: 42 }))
      expect(mocks.failure).toHaveBeenCalledWith(
        expect.objectContaining({ errorCategory: 'redirect_forbidden' }),
      )
      await processSourceConnectionPoll({ ...h.payload, mode: 'test' }, h.connector, {
        now: () => now,
        fetch,
      })
      expect(mocks.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          preview: expect.objectContaining({
            issues: ['redirect_forbidden'],
            cost: { fetches: 1, bytes: 42 },
          }),
        }),
      )
      expect(JSON.stringify(mocks.preview.mock.calls)).not.toContain('elsewhere')
    })
  })
})
