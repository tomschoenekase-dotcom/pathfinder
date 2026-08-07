import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ audit: vi.fn(), insert: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  EMBEDDING_FRESHNESS_CANARY_MAX: 10,
  insertEmbeddingFreshnessCanary: mocks.insert,
}))
vi.mock('@pathfinder/jobs/embedding-policy', () => ({ CONTENT_EMBEDDING_MAX_ATTEMPTS: 6 }))
vi.mock('./embedding-freshness', () => ({
  ACTIONABLE_EMBEDDING_FRESHNESS_REASONS: ['missing-vector-no-claim'],
  auditEmbeddingFreshness: mocks.audit,
}))

import {
  parseEmbeddingFreshnessArgs,
  runEmbeddingFreshnessCommand,
} from './embedding-freshness-cli'

describe('embedding freshness CLI', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults to a read-only tenant audit', () => {
    expect(parseEmbeddingFreshnessArgs(['--tenant-id', 'tenant_1'], {})).toEqual({
      mode: 'audit',
      tenantId: 'tenant_1',
    })
  })

  it('requires staging, an explicitly disabled dispatcher, venue, and exact cost confirmation', () => {
    const args = [
      '--tenant-id',
      'tenant_1',
      '--venue-id',
      'venue_1',
      '--entity-type',
      'PLACE',
      '--canary-reason',
      'missing-vector-no-claim',
      '--canary-limit',
      '5',
      '--confirm-canary-entities',
      '5',
      '--confirm-dispatcher-disabled',
      'true',
    ]
    expect(() => parseEmbeddingFreshnessArgs(args, {})).toThrow('requires RAILWAY_ENVIRONMENT')
    expect(() => parseEmbeddingFreshnessArgs(args, { RAILWAY_ENVIRONMENT: 'staging' })).toThrow(
      'explicit EMBEDDING_DISPATCH_ENABLED=false',
    )
    expect(
      parseEmbeddingFreshnessArgs(args, {
        RAILWAY_ENVIRONMENT: 'staging',
        EMBEDDING_DISPATCH_ENABLED: 'false',
      }),
    ).toMatchObject({ mode: 'canary', limit: 5 })
    expect(() =>
      parseEmbeddingFreshnessArgs(
        args.map((value, index) => (index === 11 ? '4' : value)),
        {
          RAILWAY_ENVIRONMENT: 'staging',
          EMBEDDING_DISPATCH_ENABLED: 'false',
        },
      ),
    ).toThrow()
  })

  it('audits without writes and canaries only selected explicit reason rows', async () => {
    mocks.audit.mockResolvedValueOnce({ truncated: false, actionableCandidates: [] })
    await expect(
      runEmbeddingFreshnessCommand({ mode: 'audit', tenantId: 'tenant_1' }),
    ).resolves.toMatchObject({ mode: 'audit' })
    expect(mocks.insert).not.toHaveBeenCalled()

    const revision = new Date('2026-08-07T20:00:00.000Z')
    mocks.audit.mockResolvedValueOnce({
      truncated: false,
      actionableCandidates: [
        {
          entityType: 'PLACE',
          entityId: 'place_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          contentUpdatedAt: revision,
          primaryReason: 'missing-vector-no-claim',
          signals: ['missing-vector'],
          actionable: true,
        },
      ],
    })
    mocks.insert.mockResolvedValueOnce({ inserted: ['place_1'], skipped: [] })
    await expect(
      runEmbeddingFreshnessCommand({
        mode: 'canary',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        reason: 'missing-vector-no-claim',
        limit: 1,
        dispatcherDisabledAsserted: true,
      }),
    ).resolves.toMatchObject({
      providerEstimate: {
        insertedEntities: 1,
        attemptsIfOneJobPerEntity: 6,
        hardUpperBound: false,
      },
      dispatcherDisablement: { independentlyVerified: false },
    })
  })

  it('refuses canary selection from a truncated audit', async () => {
    mocks.audit.mockResolvedValueOnce({ truncated: true, actionableCandidates: [] })
    await expect(
      runEmbeddingFreshnessCommand({
        mode: 'canary',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityType: 'PLACE',
        reason: 'missing-vector-no-claim',
        limit: 1,
        dispatcherDisabledAsserted: true,
      }),
    ).rejects.toThrow('refuses a truncated audit')
    expect(mocks.insert).not.toHaveBeenCalled()
  })
})
