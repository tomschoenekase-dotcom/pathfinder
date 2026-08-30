import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordWebsiteResearchReceiptAction } from '@pathfinder/db'

import { executeWebsiteIntakeResearch } from './website-intake-research-service'
import type { WebsiteIntakeDependencies } from './website-intake'

vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/db')>()
  return { ...actual, recordWebsiteResearchReceiptAction: vi.fn() }
})

const recordReceipt = vi.mocked(recordWebsiteResearchReceiptAction)
const operationId = '568c2e1a-8ece-47ad-98dc-e4bde64872ca'
const now = new Date('2026-08-25T22:00:00.000Z')

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
})
