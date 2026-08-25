import { describe, expect, it, vi } from 'vitest'

import { getIntakeBuilderLifecycle } from './intake-builder-lifecycle-service'
import { buildIntakeVenuePackageCandidate } from './intake-venue-package-candidate'

vi.mock('./intake-venue-package-candidate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./intake-venue-package-candidate')>()
  return { ...actual, buildIntakeVenuePackageCandidate: vi.fn() }
})

const buildCandidate = vi.mocked(buildIntakeVenuePackageCandidate)

describe('getIntakeBuilderLifecycle', () => {
  it('uses the exact tenant, venue, and run scope and fails website intake closed', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
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
})
