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
      nextAction: 'CONFIGURE_RESEARCH_ADAPTER',
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
})
