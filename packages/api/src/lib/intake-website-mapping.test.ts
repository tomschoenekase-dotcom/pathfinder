import { describe, expect, it, vi } from 'vitest'

import {
  buildWebsiteVenuePackageMappingCandidate,
  WebsiteMappingError,
  websiteMappingDraftKey,
} from './intake-website-mapping'

const receiptId = '768c2e1a-8ece-47ad-98dc-e4bde64872ca'
const researchSnapshot = {
  schemaVersion: 1,
  sourceId: 'run-a',
  pages: [],
  citations: [
    {
      evidenceId: 'name-a',
      fieldPath: 'venue.name',
      value: 'Example Hall',
      sourceUrl: 'https://example.org/',
      locator: 'json-ld',
      confidence: 0.95,
      dateSensitive: false,
      effectiveDate: null,
    },
    {
      evidenceId: 'name-b',
      fieldPath: 'venue.name',
      value: 'Example Ballroom',
      sourceUrl: 'https://example.org/about',
      locator: 'json-ld',
      confidence: 0.8,
      dateSensitive: false,
      effectiveDate: null,
    },
    {
      evidenceId: 'phone-a',
      fieldPath: 'venue.phone',
      value: '312-555-0100',
      sourceUrl: 'https://example.org/contact',
      locator: 'json-ld',
      confidence: 0.9,
      dateSensitive: false,
      effectiveDate: null,
    },
  ],
  evidence: [],
  discrepancies: [
    {
      id: 'name-conflict',
      fieldPath: 'venue.name',
      evidenceIds: ['name-a', 'name-b'],
      reason: 'CONTRADICTION',
    },
  ],
}

function database(questionStatus: 'PENDING' | 'ANSWERED' = 'ANSWERED') {
  return {
    intakeRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run-a',
        status: 'AWAITING_REVIEW',
        packageHandoff: null,
        websiteResearchReceipts: [
          {
            id: receiptId,
            outcome: 'SUCCEEDED',
            researchSnapshot,
            candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
          },
        ],
      }),
    },
    agentQuestion: {
      findMany: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve([
          {
            id: 'question-a',
            operationId: where.operationId.in[0],
            status: questionStatus,
            answer: questionStatus === 'ANSWERED' ? 'Use Example Hall.' : null,
            updatedAt: new Date('2026-08-25T20:00:00.000Z'),
          },
        ]),
      ),
    },
  }
}

async function researchHash() {
  const candidate = await buildWebsiteVenuePackageMappingCandidate({
    db: database() as never,
    tenantId: 'tenant-a',
    venueId: 'ckvenue00000000000000001',
    runId: 'run-a',
    receiptId,
    expectedResearchHash: '0'.repeat(64),
    selections: [{ fieldPath: 'venue.phone', evidenceId: 'phone-a' }],
  }).catch((error: WebsiteMappingError) => error)
  expect(candidate).toMatchObject({ code: 'CONFLICT' })
  const { buildWebsiteClarificationReview } = await import('./intake-website-clarifications')
  return buildWebsiteClarificationReview({
    tenantId: 'tenant-a',
    venueId: 'ckvenue00000000000000001',
    runId: 'run-a',
    receiptId,
    researchSnapshot,
    candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
  }).researchHash
}

describe('website Venue Package mapping', () => {
  it('requires answered discrepancy guidance and still maps only the human-selected citation', async () => {
    const expectedResearchHash = await researchHash()
    await expect(
      buildWebsiteVenuePackageMappingCandidate({
        db: database('PENDING') as never,
        tenantId: 'tenant-a',
        venueId: 'ckvenue00000000000000001',
        runId: 'run-a',
        receiptId,
        expectedResearchHash,
        selections: [{ fieldPath: 'venue.name', evidenceId: 'name-a' }],
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const result = await buildWebsiteVenuePackageMappingCandidate({
      db: database('ANSWERED') as never,
      tenantId: 'tenant-a',
      venueId: 'ckvenue00000000000000001',
      runId: 'run-a',
      receiptId,
      expectedResearchHash,
      selections: [
        { fieldPath: 'venue.name', evidenceId: 'name-a' },
        { fieldPath: 'venue.phone', evidenceId: 'phone-a' },
      ],
    })

    expect(result).toMatchObject({
      ready: true,
      payload: {
        schemaVersion: 3,
        venue: { identity: { name: 'Example Hall' } },
        knowledgeEntries: {
          create: [
            {
              provenance: {
                sourceType: 'PATHFINDER_INTAKE',
                sourceUrl: 'https://example.org/contact',
              },
              value: { title: 'Venue phone', content: '312-555-0100' },
            },
          ],
        },
      },
      autoApprove: false,
      autoApply: false,
      published: false,
      answersGrantAuthority: false,
    })
    expect(result.mappingReviewHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.candidateHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects invented evidence, unsupported fields, and duplicate field selections', async () => {
    const expectedResearchHash = await researchHash()
    for (const selections of [
      [{ fieldPath: 'venue.phone', evidenceId: 'invented' }],
      [{ fieldPath: 'venue.unknown', evidenceId: 'phone-a' }],
      [
        { fieldPath: 'venue.phone', evidenceId: 'phone-a' },
        { fieldPath: 'venue.phone', evidenceId: 'phone-a' },
      ],
    ]) {
      await expect(
        buildWebsiteVenuePackageMappingCandidate({
          db: database() as never,
          tenantId: 'tenant-a',
          venueId: 'ckvenue00000000000000001',
          runId: 'run-a',
          receiptId,
          expectedResearchHash,
          selections,
        }),
      ).rejects.toBeInstanceOf(WebsiteMappingError)
    }
  })

  it('derives deterministic actor-bound draft identities', () => {
    const first = websiteMappingDraftKey({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      mappingReviewHash: 'a'.repeat(64),
      actorId: 'actor-a',
    })
    expect(first).toMatch(/^[a-f0-9-]{36}$/u)
    expect(
      websiteMappingDraftKey({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        mappingReviewHash: 'a'.repeat(64),
        actorId: 'actor-b',
      }),
    ).not.toBe(first)
  })
})
