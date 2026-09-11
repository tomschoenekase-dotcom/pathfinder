import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IntakeWebsiteResearchActionError,
  recordWebsiteResearchReceiptAction,
} from './intake-website-research-actions'

const receiptFindUnique = vi.fn()
const receiptFindMany = vi.fn()
const receiptCreate = vi.fn()
const runFindFirst = vi.fn()
const eventCreate = vi.fn()
const evidenceFindUnique = vi.fn()
const evidenceCreate = vi.fn()
const auditCreate = vi.fn()
const executeRaw = vi.fn()
const client = {
  intakeRun: { findFirst: runFindFirst },
  intakeWebsiteResearchReceipt: {
    findUnique: receiptFindUnique,
    findMany: receiptFindMany,
    create: receiptCreate,
  },
  intakeEvidenceRecord: { findUnique: evidenceFindUnique, create: evidenceCreate },
  intakeRunEvent: { create: eventCreate },
  auditLog: { create: auditCreate },
  $executeRaw: executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(client)),
}

const operationId = '768c2e1a-8ece-47ad-98dc-e4bde64872ca'
const createdAt = new Date('2026-08-25T22:00:00.000Z')
const sourceHash = 'a'.repeat(64)

function discoverySnapshot(overrides: Record<string, unknown> = {}) {
  return {
    policyVersion: 1,
    observedAt: '2026-09-08T14:00:00.000Z',
    omittedCount: 0,
    items: [
      {
        url: 'https://example.org/about',
        parentUrl: 'https://example.org/',
        depth: 1,
        observedAt: '2026-09-08T14:00:00.000Z',
        disposition: 'FETCHED_TEXT',
        contentType: 'text/html; charset=utf-8',
        byteSize: 100,
        exactByteHash: 'd'.repeat(64),
      },
    ],
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    requestHash: 'b'.repeat(64),
    sourceUriHash: sourceHash,
    bounds: {
      maxPages: 5,
      maxDepth: 1,
      maxBytesPerPage: 1_000_000,
      allowedHosts: ['example.org'],
      respectRobots: true,
      publishMode: 'DRAFT_ONLY',
    },
    outcome: 'SUCCEEDED',
    researchSnapshot: {
      schemaVersion: 1,
      pages: [],
      citations: [],
      evidence: [],
      discrepancies: [],
    },
    candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
    evidence: [],
    discrepancies: [],
    attemptedFetches: 1,
    fetchedPages: 1,
    fetchedBytes: 100,
    estimatedCostUnits: 2,
    latencyMs: 50,
    createdBy: 'admin-a',
    ...overrides,
  }
}

describe('website research receipt action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    receiptFindUnique.mockResolvedValue(null)
    receiptFindMany.mockResolvedValue([])
    runFindFirst.mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      websiteUri: 'https://example.org/',
    })
    receiptCreate.mockResolvedValue({ id: operationId, outcome: 'SUCCEEDED', createdAt })
    auditCreate.mockResolvedValue({ id: 'audit-a' })
    executeRaw.mockResolvedValue(1)
  })

  it('records append-only terminal evidence, event, and strict audit without downstream actions', async () => {
    const crypto = await import('node:crypto')
    const result = await recordWebsiteResearchReceiptAction(
      input({
        sourceUriHash: crypto.createHash('sha256').update('https://example.org/').digest('hex'),
        discoverySnapshot: discoverySnapshot(),
        evidence: [
          {
            id: 'evidence-a',
            sourceId: 'run-a',
            locator: 'https://example.org/#title',
            normalizedHash: 'c'.repeat(64),
            confidence: 0.9,
            capturedAt: createdAt.toISOString(),
          },
        ],
      }) as never,
      client as never,
    )

    expect(receiptFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: operationId,
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'run-a',
        },
      }),
    )
    expect(evidenceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'evidence-a',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          runId: 'run-a',
          sourceKind: 'WEBSITE',
        },
      }),
    )
    expect(receiptCreate).toHaveBeenCalledOnce()
    expect(receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discoverySnapshot: discoverySnapshot() }),
      }),
    )
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'WEBSITE_RESEARCH_RECORDED' }),
      }),
    )
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'intake.website-research-recorded' }),
      }),
    )
    expect(result).toMatchObject({
      replayed: false,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ discoveryItemCount: 1, discoveryOmittedCount: 0 }),
        }),
      }),
    )
  })

  it('normalizes a legacy undefined discovery field to null for exact replay and rejects a changed inventory', async () => {
    const crypto = await import('node:crypto')
    const sourceUriHash = crypto.createHash('sha256').update('https://example.org/').digest('hex')
    const replayInput = input({ sourceUriHash })
    receiptFindUnique.mockResolvedValueOnce({
      id: operationId,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      priorReceiptId: null,
      requestHash: 'b'.repeat(64),
      sourceUriHash,
      outcome: 'SUCCEEDED',
      bounds: replayInput.bounds,
      researchSnapshot: replayInput.researchSnapshot,
      candidateSnapshot: replayInput.candidateSnapshot,
      attemptedFetches: 1,
      fetchedPages: 1,
      fetchedBytes: 100,
      estimatedCostUnits: 2,
      latencyMs: 50,
      errorCode: null,
      errorMessage: null,
      createdBy: 'admin-a',
      createdAt,
    })
    await expect(
      recordWebsiteResearchReceiptAction(replayInput as never, client as never),
    ).resolves.toMatchObject({
      replayed: true,
    })
    expect(receiptCreate).not.toHaveBeenCalled()

    receiptFindUnique.mockResolvedValueOnce({
      id: operationId,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      priorReceiptId: null,
      requestHash: 'b'.repeat(64),
      sourceUriHash,
      outcome: 'SUCCEEDED',
      bounds: replayInput.bounds,
      researchSnapshot: replayInput.researchSnapshot,
      candidateSnapshot: replayInput.candidateSnapshot,
      discoverySnapshot: discoverySnapshot(),
      attemptedFetches: 1,
      fetchedPages: 1,
      fetchedBytes: 100,
      estimatedCostUnits: 2,
      latencyMs: 50,
      errorCode: null,
      errorMessage: null,
      createdBy: 'admin-a',
      createdAt,
    })
    await expect(
      recordWebsiteResearchReceiptAction(replayInput as never, client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('retains a zero-page inaccessible discovery inventory without candidate or extracted evidence', async () => {
    const crypto = await import('node:crypto')
    const sourceUriHash = crypto.createHash('sha256').update('https://example.org/').digest('hex')
    receiptCreate.mockResolvedValueOnce({ id: operationId, outcome: 'INACCESSIBLE', createdAt })
    const inaccessibleDiscovery = discoverySnapshot({
      items: [
        {
          url: 'https://example.org/',
          parentUrl: null,
          depth: 0,
          observedAt: '2026-09-08T14:00:00.000Z',
          disposition: 'ROBOTS_DENIED',
        },
      ],
    })
    await recordWebsiteResearchReceiptAction(
      input({
        sourceUriHash,
        outcome: 'INACCESSIBLE',
        researchSnapshot: undefined,
        candidateSnapshot: undefined,
        discoverySnapshot: inaccessibleDiscovery,
        errorCode: 'NO_ACCESSIBLE_PAGES',
        fetchedPages: 0,
        fetchedBytes: 0,
      }) as never,
      client as never,
    )
    expect(receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'INACCESSIBLE',
          discoverySnapshot: inaccessibleDiscovery,
        }),
      }),
    )
    const receiptData = receiptCreate.mock.calls[0]?.[0].data
    expect(receiptData).not.toHaveProperty('researchSnapshot')
    expect(receiptData).not.toHaveProperty('candidateSnapshot')
    expect(evidenceCreate).not.toHaveBeenCalled()
  })

  it('rejects inaccessible discovery that claims fetched text or a different terminal reason', async () => {
    const crypto = await import('node:crypto')
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          sourceUriHash: crypto.createHash('sha256').update('https://example.org/').digest('hex'),
          outcome: 'INACCESSIBLE',
          researchSnapshot: undefined,
          candidateSnapshot: undefined,
          discoverySnapshot: discoverySnapshot(),
          errorCode: 'SOURCE_INACCESSIBLE',
          fetchedPages: 0,
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('rejects failure receipts that claim extracted evidence before touching the database', async () => {
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          outcome: 'FAILED',
          researchSnapshot: undefined,
          candidateSnapshot: undefined,
          errorCode: 'RUNTIME_FAILURE',
          evidence: [
            {
              id: 'evidence-a',
              sourceKind: 'WEBSITE',
              locator: 'page',
              normalizedHash: 'c'.repeat(64),
              confidence: 0.9,
              capturedAt: createdAt.toISOString(),
            },
          ],
        }) as never,
        client as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeWebsiteResearchActionError>>({ code: 'INVALID_INPUT' }),
    )
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('rejects failed candidate/discovery claims before touching the database', async () => {
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          outcome: 'FAILED',
          researchSnapshot: undefined,
          candidateSnapshot: { kind: 'forbidden' },
          discoverySnapshot: discoverySnapshot(),
          errorCode: 'RUNTIME_FAILURE',
          fetchedPages: 0,
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('rejects otherwise valid discovery URLs outside the exact source host before receipt creation', async () => {
    const crypto = await import('node:crypto')
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          sourceUriHash: crypto.createHash('sha256').update('https://example.org/').digest('hex'),
          discoverySnapshot: discoverySnapshot({
            items: [
              {
                url: 'https://outside.example/about',
                parentUrl: null,
                depth: 0,
                observedAt: '2026-09-08T14:00:00.000Z',
                disposition: 'FETCHED_TEXT',
                byteSize: 1,
                exactByteHash: 'e'.repeat(64),
              },
            ],
          }),
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(receiptCreate).not.toHaveBeenCalled()
  })

  it('derives failure detail from the bounded code and rejects unknown codes', async () => {
    const crypto = await import('node:crypto')
    const sourceUriHash = crypto.createHash('sha256').update('https://example.org/').digest('hex')
    receiptCreate.mockResolvedValueOnce({ id: operationId, outcome: 'FAILED', createdAt })
    await recordWebsiteResearchReceiptAction(
      input({
        sourceUriHash,
        outcome: 'FAILED',
        researchSnapshot: undefined,
        candidateSnapshot: undefined,
        errorCode: 'RUNTIME_FAILURE',
        fetchedPages: 0,
      }) as never,
      client as never,
    )

    expect(receiptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: 'RUNTIME_FAILURE',
          errorMessage: 'Website research failed before a reviewable result was retained.',
        }),
      }),
    )

    vi.clearAllMocks()
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          sourceUriHash,
          outcome: 'FAILED',
          researchSnapshot: undefined,
          candidateSnapshot: undefined,
          errorCode: 'SECRET_PROVIDER_FAILURE',
          fetchedPages: 0,
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a retry after terminal success under the run advisory lock', async () => {
    const crypto = await import('node:crypto')
    receiptFindMany.mockResolvedValue([{ id: operationId, outcome: 'SUCCEEDED' }])
    await expect(
      recordWebsiteResearchReceiptAction(
        input({
          operationId: '868c2e1a-8ece-47ad-98dc-e4bde64872ca',
          priorReceiptId: operationId,
          sourceUriHash: crypto.createHash('sha256').update('https://example.org/').digest('hex'),
        }) as never,
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(receiptCreate).not.toHaveBeenCalled()
  })
})
