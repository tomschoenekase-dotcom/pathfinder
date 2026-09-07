import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordWebsiteResearchReceiptAction } from '@pathfinder/db'

import { executeWebsiteIntakeResearch } from './website-intake-research-service'
import { WebsiteIntakePolicyError, type WebsiteIntakeDependencies } from './website-intake'

vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  return { ...actual, recordWebsiteResearchReceiptAction: vi.fn() }
})

const recordReceipt = vi.mocked(recordWebsiteResearchReceiptAction)
const operationId = '568c2e1a-8ece-47ad-98dc-e4bde64872ca'
const now = new Date('2026-08-25T22:00:00.000Z')
// Frozen SHA-256 of the pre-v2 stable canonical request material for request().
// This literal is retained from the pre-change hash contract for replay coverage.
const LEGACY_REQUEST_HASH = '41305b6ebaf1e3809ea10c4deed2103fa59ec574b09a6aea5ac8a3d42d101f57'

function request() {
  return {
    operationId,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    maxPages: 5,
    maxDepth: 1,
    maxBytesPerPage: 1_000_000,
    maxDurationMs: 30_000,
    maxCostUnits: 20,
    userAgent: 'TorchikoBuilder/1.0',
    createdBy: 'admin-a',
  }
}

function dependencies(): WebsiteIntakeDependencies {
  return {
    resolveHostname: vi.fn(async () => ['93.184.216.34']),
    robots: { canFetch: vi.fn(async () => true) },
    fetchPage: vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<title>Example Hall</title>',
    })),
    extractPage: vi.fn(async () => ({
      links: [],
      facts: [{ fieldPath: 'venue.name', value: 'Example Hall', confidence: 0.9 }],
    })),
    now: () => now,
  }
}

function database(overrides: { existing?: unknown; prior?: unknown[] } = {}) {
  return {
    intakeRun: {
      findFirst: vi.fn(async () => ({
        id: 'run-a',
        sourceKind: 'WEBSITE',
        websiteUri: 'https://example.org/',
      })),
    },
    intakeWebsiteResearchReceipt: {
      findUnique: vi.fn(async () => overrides.existing ?? null),
      findMany: vi.fn(async () => overrides.prior ?? []),
    },
  }
}

describe('website intake research execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recordReceipt.mockResolvedValue({
      receiptId: operationId,
      outcome: 'SUCCEEDED',
      createdAt: now,
      replayed: false,
      evidenceRecorded: true,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
  })

  it('executes the bounded crawler and records terminal evidence without downstream authority', async () => {
    const deps = dependencies()
    const db = database()
    const result = await executeWebsiteIntakeResearch({
      db: db as never,
      request: request(),
      dependencies: deps,
      now: () => now,
    })

    expect(db.intakeWebsiteResearchReceipt.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: operationId,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'run-a',
        },
      }),
    )
    expect(deps.fetchPage).toHaveBeenCalledOnce()
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        outcome: 'SUCCEEDED',
        attemptedFetches: 1,
        fetchedPages: 1,
        estimatedCostUnits: 2,
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
      }),
      expect.anything(),
    )
    expect(result).toMatchObject({
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
  })

  it('replays an exact operation before performing network work', async () => {
    const deps = dependencies()
    const db = database({
      existing: {
        id: operationId,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        requestHash: 'ignored',
        createdBy: 'admin-a',
        outcome: 'FAILED',
        createdAt: now,
      },
    })
    const expectedHash = await executeWebsiteIntakeResearch({
      db: database() as never,
      request: request(),
      dependencies: deps,
      now: () => now,
    }).then(() => recordReceipt.mock.calls[0]?.[0].requestHash)
    const expectedSourceHash = recordReceipt.mock.calls[0]?.[0].sourceUriHash
    vi.clearAllMocks()
    ;(db.intakeWebsiteResearchReceipt.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: operationId,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      priorReceiptId: null,
      requestHash: expectedHash,
      sourceUriHash: expectedSourceHash,
      createdBy: 'admin-a',
      outcome: 'FAILED',
      createdAt: now,
    })

    const result = await executeWebsiteIntakeResearch({
      db: db as never,
      request: request(),
      dependencies: deps,
      now: () => now,
    })
    expect(result).toMatchObject({ replayed: true, outcome: 'FAILED' })
    expect(deps.fetchPage).not.toHaveBeenCalled()
    expect(recordReceipt).not.toHaveBeenCalled()
  })

  it('rejects retry after a successful receipt before performing network work', async () => {
    const deps = dependencies()
    await expect(
      executeWebsiteIntakeResearch({
        db: database({ prior: [{ id: operationId, outcome: 'SUCCEEDED' }] }) as never,
        request: { ...request(), operationId: '668c2e1a-8ece-47ad-98dc-e4bde64872ca' },
        dependencies: deps,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(deps.fetchPage).not.toHaveBeenCalled()
  })

  it('retains a code-derived policy failure without the provider exception text', async () => {
    const deps = dependencies()
    deps.extractPage = vi.fn(async () => {
      throw new WebsiteIntakePolicyError(
        'Extractor rejected https://user:secret@example.org/?api_key=top-secret',
      )
    })

    await executeWebsiteIntakeResearch({
      db: database() as never,
      request: request(),
      dependencies: deps,
      now: () => now,
    })

    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'EXTRACTION_FAILED',
      }),
      expect.anything(),
    )
    expect(JSON.stringify(recordReceipt.mock.calls)).not.toContain('top-secret')
    expect(JSON.stringify(recordReceipt.mock.calls)).not.toContain('user:secret')
    expect(recordReceipt.mock.calls[0]?.[0]).not.toHaveProperty('errorMessage')
  })

  it('replays a pre-v2 legacy hash without fetch or receipt writes', async () => {
    const deps = dependencies()
    const db = database({
      existing: {
        id: operationId,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        requestHash: LEGACY_REQUEST_HASH,
        priorReceiptId: null,
        sourceUriHash: '8198d1bac40a1033653a78e48800cefc9e6b974ff075c66e5548b5c1e145a2b0',
        createdBy: 'admin-a',
        outcome: 'SUCCEEDED',
        createdAt: now,
      },
    })

    await expect(
      executeWebsiteIntakeResearch({ db: db as never, request: request(), dependencies: deps }),
    ).resolves.toMatchObject({ replayed: true, outcome: 'SUCCEEDED' })
    expect(deps.fetchPage).not.toHaveBeenCalled()
    expect(recordReceipt).not.toHaveBeenCalled()
  })

  it.each([
    ['maxCostUnits', { maxCostUnits: 21 }],
    ['scope', { venueId: 'venue-b' }],
  ])('rejects legacy replay when %s changes', async (_label, change) => {
    const deps = dependencies()
    const db = database({
      existing: {
        id: operationId,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        requestHash: LEGACY_REQUEST_HASH,
        priorReceiptId: null,
        sourceUriHash: '8198d1bac40a1033653a78e48800cefc9e6b974ff075c66e5548b5c1e145a2b0',
        createdBy: 'admin-a',
        outcome: 'SUCCEEDED',
        createdAt: now,
      },
    })
    await expect(
      executeWebsiteIntakeResearch({
        db: db as never,
        request: { ...request(), ...change },
        dependencies: deps,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(deps.fetchPage).not.toHaveBeenCalled()
    expect(recordReceipt).not.toHaveBeenCalled()
  })

  it('uses a different hash for a newly executed v2 receipt', async () => {
    const deps = dependencies()
    await executeWebsiteIntakeResearch({
      db: database() as never,
      request: request(),
      dependencies: deps,
    })
    expect(recordReceipt.mock.calls[0]?.[0].requestHash).toBeDefined()
    expect(recordReceipt.mock.calls[0]?.[0].requestHash).not.toBe(LEGACY_REQUEST_HASH)
  })

  it('reserves one engineering cost unit before each redirect fetch and retains the blocked attempt work', async () => {
    const deps = dependencies()
    deps.fetchPage = vi.fn(async () => ({
      status: 302,
      headers: { location: '/next' },
      body: '',
    }))

    await executeWebsiteIntakeResearch({
      db: database() as never,
      request: { ...request(), maxPages: 1, maxCostUnits: 1 },
      dependencies: deps,
      now: () => now,
    })

    expect(deps.fetchPage).toHaveBeenCalledOnce()
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'COST_LIMIT',
        attemptedFetches: 1,
        fetchedPages: 0,
        fetchedBytes: 0,
        estimatedCostUnits: 1,
      }),
      expect.anything(),
    )
  })

  it.each([
    ['an HTTP failure', async () => ({ status: 503, headers: {}, body: '' })],
    ['a thrown fetch', async () => Promise.reject(new Error('transport failed'))],
  ])('retains one attempt unit when %s prevents page extraction', async (_label, fetchPage) => {
    const deps = dependencies()
    deps.fetchPage = vi.fn(fetchPage)

    await executeWebsiteIntakeResearch({
      db: database() as never,
      request: { ...request(), maxCostUnits: 1 },
      dependencies: deps,
      now: () => now,
    })

    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptedFetches: 1,
        fetchedPages: 0,
        fetchedBytes: 0,
        estimatedCostUnits: 1,
      }),
      expect.anything(),
    )
  })

  it('charges observed successful body bytes once after reserving the fetch attempt', async () => {
    const deps = dependencies()
    await executeWebsiteIntakeResearch({
      db: database() as never,
      request: { ...request(), maxCostUnits: 1 },
      dependencies: deps,
      now: () => now,
    })

    expect(deps.fetchPage).toHaveBeenCalledOnce()
    expect(deps.extractPage).not.toHaveBeenCalled()
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        errorCode: 'COST_LIMIT',
        attemptedFetches: 1,
        fetchedPages: 0,
        fetchedBytes: Buffer.byteLength('<title>Example Hall</title>', 'utf8'),
        estimatedCostUnits: 2,
      }),
      expect.anything(),
    )
  })
})
