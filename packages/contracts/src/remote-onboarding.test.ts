import { describe, expect, it } from 'vitest'

import { resolveClientPortalLifecycle } from './client-portal-lifecycle'
import {
  resolveRemoteOnboardingProjection,
  type RemoteOnboardingEvidence,
} from './remote-onboarding'

function evidence(overrides: Partial<RemoteOnboardingEvidence> = {}): RemoteOnboardingEvidence {
  return {
    lifecycle: resolveClientPortalLifecycle({
      isActive: false,
      publicContentCount: 0,
      wasLive: false,
      collectingSourceCount: 0,
      processingSourceCount: 0,
      reviewSourceCount: 0,
      intakeProposalCount: 0,
      packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
      hasActiveOffboarding: false,
    }),
    materials: {
      uploaded: 0,
      checking: 0,
      checksNeedAction: 0,
      checksWaitingOnTorchiko: 0,
      needsAttention: 0,
      readyForReview: 0,
      processed: 0,
    },
    review: { proposedSources: 0, draftPackages: 0 },
    questions: { open: 0 },
    preview: { state: 'UNAVAILABLE', packageId: null },
    qa: {
      state: 'NOT_RUN',
      passed: 0,
      failed: 0,
      operationalIssues: 0,
      requiredDimensions: 7,
      assessedDimensions: 0,
      exactPackage: false,
    },
    release: { hasReviewedArtifact: false, released: false },
    ...overrides,
  }
}

describe('remote onboarding journey projection', () => {
  it('offers one obvious website-first action for a new venue', () => {
    const result = resolveRemoteOnboardingProjection(evidence())
    expect(result.primaryAction).toMatchObject({
      kind: 'START_MATERIALS',
      stage: 'MATERIALS',
      label: 'Start with my website',
      required: true,
    })
    expect(result.stages.find(({ id }) => id === 'MATERIALS')?.status).toBe('AVAILABLE')
    expect(result.readiness.every(({ status }) => status === 'NOT_ASSESSED')).toBe(true)
  })

  it('prioritizes a focused client question over preview and never implies publication', () => {
    const result = resolveRemoteOnboardingProjection(
      evidence({
        questions: { open: 2 },
        preview: { state: 'AVAILABLE', packageId: 'package-1' },
        release: { hasReviewedArtifact: true, released: false },
      }),
    )
    expect(result.primaryAction).toMatchObject({
      kind: 'ANSWER_QUESTION',
      stage: 'QUESTIONS',
      required: true,
    })
    expect(result.readiness.find(({ id }) => id === 'RELEASE')).toMatchObject({
      status: 'NOT_ASSESSED',
      summary: expect.stringContaining('explicit operator action'),
    })
  })

  it('separates QA failures from other readiness dimensions', () => {
    const result = resolveRemoteOnboardingProjection(
      evidence({
        materials: {
          uploaded: 0,
          checking: 0,
          checksNeedAction: 0,
          checksWaitingOnTorchiko: 0,
          needsAttention: 0,
          readyForReview: 2,
          processed: 1,
        },
        qa: {
          state: 'COMPLETED',
          passed: 42,
          failed: 3,
          operationalIssues: 0,
          safetyCriticalFailed: 1,
          requiredDimensions: 7,
          assessedDimensions: 7,
          exactPackage: true,
        },
      }),
    )
    expect(result.readiness.find(({ id }) => id === 'AUTOMATED_QA')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      summary:
        '42 passed; 3 failed; 0 could not be scored. 1 safety-critical failure(s) block release.',
    })
    expect(result.readiness.find(({ id }) => id === 'SOURCES')?.status).toBe('READY')
  })

  it('does not call a completed run ready when it is stale or missing packet dimensions', () => {
    const result = resolveRemoteOnboardingProjection(
      evidence({
        qa: {
          state: 'COMPLETED',
          passed: 3,
          failed: 0,
          operationalIssues: 0,
          requiredDimensions: 7,
          assessedDimensions: 3,
          exactPackage: true,
        },
      }),
    )
    expect(result.readiness.find(({ id }) => id === 'AUTOMATED_QA')).toMatchObject({
      status: 'NOT_ASSESSED',
      summary:
        '3 of 7 required onboarding dimensions have terminal evidence for the exact approved package.',
    })
  })

  it('makes persisted intake resumable without asking the client to keep supplying sources', () => {
    const checking = resolveRemoteOnboardingProjection(
      evidence({
        lifecycle: resolveClientPortalLifecycle({
          isActive: false,
          publicContentCount: 0,
          wasLive: false,
          collectingSourceCount: 0,
          processingSourceCount: 1,
          reviewSourceCount: 0,
          intakeProposalCount: 0,
          packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
          hasActiveOffboarding: false,
        }),
        materials: {
          uploaded: 0,
          checking: 1,
          checksNeedAction: 0,
          checksWaitingOnTorchiko: 0,
          needsAttention: 0,
          readyForReview: 0,
          processed: 0,
        },
      }),
    )
    expect(checking.primaryAction).toEqual({
      kind: 'VIEW_PROGRESS',
      stage: 'OVERVIEW',
      label: 'See what happens next',
      reason:
        'Your information is saved and being checked. You can leave this page and return later.',
      required: false,
    })

    const waitingOnTorchiko = resolveRemoteOnboardingProjection(
      evidence({
        materials: {
          uploaded: 0,
          checking: 0,
          checksNeedAction: 0,
          checksWaitingOnTorchiko: 1,
          needsAttention: 0,
          readyForReview: 0,
          processed: 0,
        },
      }),
    )
    expect(waitingOnTorchiko.primaryAction).toMatchObject({
      kind: 'VIEW_PROGRESS',
      required: false,
      reason: expect.stringContaining('Torchiko still needs to finish'),
    })

    const resumable = resolveRemoteOnboardingProjection(
      evidence({
        materials: {
          uploaded: 0,
          checking: 0,
          checksNeedAction: 2,
          checksWaitingOnTorchiko: 0,
          needsAttention: 0,
          readyForReview: 0,
          processed: 0,
        },
      }),
    )
    expect(resumable.primaryAction).toEqual({
      kind: 'RESUME_MATERIAL_CHECK',
      stage: 'MATERIALS',
      label: 'Resume file check',
      reason: '2 saved files need the check resumed. You do not need to upload them again.',
      required: true,
    })

    const submitted = resolveRemoteOnboardingProjection(
      evidence({ review: { proposedSources: 1, draftPackages: 0 } }),
    )
    expect(submitted.primaryAction).toEqual({
      kind: 'REVIEW_SOURCES',
      stage: 'REVIEW',
      label: 'See what you shared',
      reason:
        'Your information is saved for Torchiko review. You can add a correction now or return later.',
      required: false,
    })

    const verifiedFile = resolveRemoteOnboardingProjection(
      evidence({
        materials: {
          uploaded: 0,
          checking: 0,
          checksNeedAction: 0,
          checksWaitingOnTorchiko: 0,
          needsAttention: 0,
          readyForReview: 1,
          processed: 0,
        },
      }),
    )
    expect(verifiedFile.primaryAction).toEqual({
      kind: 'VIEW_PROGRESS',
      stage: 'OVERVIEW',
      label: 'See what happens next',
      reason: 'Your information is saved. Torchiko will ask if another detail is needed.',
      required: false,
    })
  })

  it('exposes one exact replacement action without altering other saved source state', () => {
    const result = resolveRemoteOnboardingProjection(
      evidence({
        materials: {
          uploaded: 0,
          checking: 0,
          checksNeedAction: 0,
          checksWaitingOnTorchiko: 0,
          needsAttention: 2,
          readyForReview: 3,
          processed: 1,
        },
      }),
    )

    expect(result.primaryAction).toEqual({
      kind: 'CHOOSE_REPLACEMENT',
      stage: 'MATERIALS',
      label: 'Choose a replacement file',
      reason: '2 files could not be accepted. Other submitted information remains unchanged.',
      required: true,
    })
    expect(result.stages.find(({ id }) => id === 'MATERIALS')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      summary: '2 files need a safe retry or replacement.',
    })
  })
})
