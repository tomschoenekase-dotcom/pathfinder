import { describe, expect, it, vi } from 'vitest'

import { getIntakeBuilderLifecycle } from './intake-builder-lifecycle-service'
import { buildIntakeVenuePackageCandidate } from './intake-venue-package-candidate'

vi.mock('./intake-venue-package-candidate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./intake-venue-package-candidate')>()
  return { ...actual, buildIntakeVenuePackageCandidate: vi.fn() }
})

const buildCandidate = vi.mocked(buildIntakeVenuePackageCandidate)

describe('getIntakeBuilderLifecycle', () => {
  it('uses exact scope and exposes research for a newly recorded zero-evidence website source', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 0 },
      websiteResearchReceipts: [],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-a', tenantId: 'tenant-a', venueId: 'venue-a' },
      }),
    )
    expect(buildCandidate).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RUN_WEBSITE_RESEARCH',
    })
    expect(result.stages.find(({ stage }) => stage === 'NORMALIZE')).toMatchObject({
      state: 'COMPLETE',
      evidenceRefs: expect.arrayContaining(['website-source:run-a']),
    })
  })

  it('projects malformed stored package evidence as a blocker', async () => {
    buildCandidate.mockResolvedValueOnce({
      runId: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      ready: true,
      payload: {} as never,
      candidateHash: 'a'.repeat(64),
      issues: [],
      summary: { candidateCount: 1, issueCount: 0 },
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 2 },
      websiteResearchReceipts: [],
      packageHandoff: {
        packageDraft: {
          id: 'package-a',
          status: 'DRAFT',
          validationReport: {},
          previewPlan: {},
          duplicateAnalysis: { status: 'COMPLETE' },
        },
      },
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(buildCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        allowExistingHandoff: true,
      }),
    )
    expect(result).toMatchObject({
      currentStage: 'VALIDATE',
      currentState: 'BLOCKED',
      nextAction: 'REPAIR_PACKAGE_EVIDENCE',
    })
  })

  it('projects retained website citations into an explicitly unmapped review candidate', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      websiteResearchReceipts: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          outcome: 'SUCCEEDED',
          researchSnapshot: {
            schemaVersion: 1,
            sourceId: 'run-a',
            pages: [
              {
                url: 'https://example.org/',
                depth: 0,
                byteSize: 10,
                normalizedHash: 'a'.repeat(64),
              },
            ],
            citations: [
              {
                evidenceId: 'evidence-a',
                fieldPath: 'venue.name',
                value: 'Example Hall',
                sourceUrl: 'https://example.org/',
                locator: 'title',
                confidence: 0.9,
                dateSensitive: false,
                effectiveDate: null,
              },
            ],
            evidence: [],
            discrepancies: [],
          },
          candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
          attemptedFetches: 1,
          fetchedPages: 1,
          fetchedBytes: 10,
          estimatedCostUnits: 2,
          latencyMs: 40,
          errorCode: null,
          errorMessage: null,
        },
      ],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      nextAction: 'RESOLVE_CLARIFICATION',
      websiteResearch: {
        outcome: 'SUCCEEDED',
        attemptCount: 1,
        canRetry: false,
        fetchedPages: 1,
      },
    })
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')?.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'WEBSITE_MAPPING_REQUIRED' })]),
    )
  })

  it('reads durable clarification answers as guidance while keeping mapping blocked', async () => {
    const researchSnapshot = {
      schemaVersion: 1,
      sourceId: 'run-a',
      pages: [],
      citations: [
        {
          evidenceId: 'evidence-a',
          fieldPath: 'venue.name',
          value: 'Example Hall',
          sourceUrl: 'https://example.org/',
          locator: 'title',
          confidence: 0.9,
          dateSensitive: false,
          effectiveDate: null,
        },
        {
          evidenceId: 'evidence-b',
          fieldPath: 'venue.name',
          value: 'Example Ballroom',
          sourceUrl: 'https://example.org/about',
          locator: 'meta title',
          confidence: 0.7,
          dateSensitive: false,
          effectiveDate: null,
        },
      ],
      evidence: [],
      discrepancies: [
        {
          id: 'discrepancy-a',
          fieldPath: 'venue.name',
          evidenceIds: ['evidence-a', 'evidence-b'],
          reason: 'CONTRADICTION',
        },
      ],
    }
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      websiteResearchReceipts: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          outcome: 'SUCCEEDED',
          researchSnapshot,
          candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
          attemptedFetches: 2,
          fetchedPages: 2,
          fetchedBytes: 20,
          estimatedCostUnits: 3,
          latencyMs: 50,
          errorCode: null,
          errorMessage: null,
        },
      ],
      packageHandoff: null,
    })
    const questionFindMany = vi.fn().mockImplementation(({ where }) =>
      Promise.resolve([
        {
          id: 'question-a',
          operationId: where.operationId.in[0],
          status: 'ANSWERED',
          answer: 'Use Example Hall.',
          agentIdentityId: 'identity-a',
          updatedAt: new Date('2026-08-25T20:00:00.000Z'),
        },
      ]),
    )

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: questionFindMany },
        agentIdentity: {
          findMany: vi.fn().mockResolvedValue([{ id: 'identity-a', name: 'Content' }]),
        },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result.websiteClarificationReview).toMatchObject({
      answersGrantAuthority: false,
      clarifications: [
        {
          discrepancyId: 'discrepancy-a',
          question: {
            id: 'question-a',
            status: 'ANSWERED',
            answer: 'Use Example Hall.',
            answerGuidanceOnly: true,
          },
        },
      ],
    })
    expect(result.currentStage).toBe('RECONCILE')
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('guidance only') }),
        expect.objectContaining({ code: 'WEBSITE_MAPPING_REQUIRED' }),
      ]),
    )
  })
})
