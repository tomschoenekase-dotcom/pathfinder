import type { ClientPortalLifecycleView } from './client-portal-lifecycle'

export const REMOTE_ONBOARDING_PROJECTION_VERSION = 1 as const

export const REMOTE_ONBOARDING_STAGES = [
  'OVERVIEW',
  'MATERIALS',
  'REVIEW',
  'QUESTIONS',
  'PREVIEW',
  'READINESS',
] as const

export type RemoteOnboardingStageId = (typeof REMOTE_ONBOARDING_STAGES)[number]
export type RemoteOnboardingStageStatus =
  | 'NOT_STARTED'
  | 'AVAILABLE'
  | 'IN_PROGRESS'
  | 'NEEDS_ATTENTION'
  | 'COMPLETE'
export type RemoteOnboardingReadinessStatus =
  | 'NOT_ASSESSED'
  | 'IN_PROGRESS'
  | 'NEEDS_ATTENTION'
  | 'READY'

export type RemoteOnboardingEvidence = {
  lifecycle: ClientPortalLifecycleView
  materials: {
    uploaded: number
    checking: number
    needsAttention: number
    readyForReview: number
    processed: number
  }
  review: {
    proposedSources: number
    draftPackages: number
  }
  questions: {
    open: number
  }
  preview: {
    state: 'AVAILABLE' | 'SUPERSEDED' | 'UNAVAILABLE'
    packageId: string | null
  }
  qa: {
    state: 'NOT_RUN' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
    passed: number
    failed: number
    operationalIssues: number
    /** Failed cases whose stable case key is explicitly safety critical. */
    safetyCriticalFailed?: number
    requiredDimensions: number
    assessedDimensions: number
    exactPackage: boolean
  }
  release: {
    hasReviewedArtifact: boolean
    released: boolean
  }
}

export type RemoteOnboardingProjection = {
  version: typeof REMOTE_ONBOARDING_PROJECTION_VERSION
  primaryAction: {
    stage: RemoteOnboardingStageId
    label: string
    reason: string
  }
  stages: Array<{
    id: RemoteOnboardingStageId
    label: string
    status: RemoteOnboardingStageStatus
    summary: string
  }>
  readiness: Array<{
    id: 'CONTENT' | 'SOURCES' | 'QUESTIONS' | 'AUTOMATED_QA' | 'CLIENT_REVIEW' | 'RELEASE'
    label: string
    status: RemoteOnboardingReadinessStatus
    summary: string
  }>
}

function plural(count: number, singular: string, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`
}

export function resolveRemoteOnboardingProjection(
  evidence: RemoteOnboardingEvidence,
): RemoteOnboardingProjection {
  const materialTotal = Object.values(evidence.materials).reduce((sum, count) => sum + count, 0)
  const hasMaterials = materialTotal > 0 || evidence.review.proposedSources > 0
  const reviewAvailable = evidence.review.proposedSources + evidence.review.draftPackages > 0
  const previewAvailable =
    evidence.preview.state === 'AVAILABLE' && Boolean(evidence.preview.packageId)
  const qaCoverageComplete =
    evidence.qa.exactPackage &&
    evidence.qa.requiredDimensions > 0 &&
    evidence.qa.assessedDimensions >= evidence.qa.requiredDimensions
  const qaComplete = evidence.qa.state === 'COMPLETED' && qaCoverageComplete
  const qaNeedsAttention =
    evidence.qa.failed > 0 || evidence.qa.operationalIssues > 0 || evidence.qa.state === 'FAILED'

  const primaryAction: RemoteOnboardingProjection['primaryAction'] =
    evidence.questions.open > 0
      ? {
          stage: 'QUESTIONS',
          label: 'Answer the next question',
          reason: `${plural(evidence.questions.open, 'focused question')} will help Torchiko continue.`,
        }
      : evidence.materials.needsAttention > 0
        ? {
            stage: 'MATERIALS',
            label: 'Fix a material that needs attention',
            reason: 'One or more files could not pass the safety and verification checks.',
          }
        : previewAvailable
          ? {
              stage: 'PREVIEW',
              label: 'Test the visitor experience',
              reason: 'A reviewed candidate is ready for your feedback.',
            }
          : !hasMaterials
            ? {
                stage: 'MATERIALS',
                label: 'Start with my website',
                reason:
                  'A website is usually the quickest way to give Torchiko a useful starting point.',
              }
            : evidence.materials.checking > 0 || evidence.lifecycle.state === 'PROCESSING'
              ? {
                  stage: 'OVERVIEW',
                  label: 'View processing progress',
                  reason: 'Torchiko is safely organizing the materials you shared.',
                }
              : reviewAvailable
                ? {
                    stage: 'REVIEW',
                    label: 'Review what Torchiko found',
                    reason: 'Your source material has been organized into reviewable information.',
                  }
                : {
                    stage: 'MATERIALS',
                    label: 'Add another useful source',
                    reason:
                      'Another website, document, photo, map, or staff answer can improve coverage.',
                  }

  const stages: RemoteOnboardingProjection['stages'] = [
    {
      id: 'OVERVIEW',
      label: 'Overview',
      status: 'COMPLETE',
      summary: evidence.lifecycle.headline,
    },
    {
      id: 'MATERIALS',
      label: 'Materials',
      status:
        evidence.materials.needsAttention > 0
          ? 'NEEDS_ATTENTION'
          : evidence.materials.checking > 0
            ? 'IN_PROGRESS'
            : hasMaterials
              ? 'COMPLETE'
              : 'AVAILABLE',
      summary: !hasMaterials
        ? 'Start with a website or share whatever materials you already have.'
        : evidence.materials.needsAttention > 0
          ? `${plural(evidence.materials.needsAttention, 'file')} need a safe retry or replacement.`
          : evidence.materials.checking > 0
            ? `${plural(evidence.materials.checking, 'file')} are being checked.`
            : 'Your shared materials are safely recorded.',
    },
    {
      id: 'REVIEW',
      label: 'Review',
      status: reviewAvailable ? 'AVAILABLE' : hasMaterials ? 'IN_PROGRESS' : 'NOT_STARTED',
      summary: reviewAvailable
        ? 'Review organized information instead of raw extraction data.'
        : 'Torchiko will organize useful facts into clear sections.',
    },
    {
      id: 'QUESTIONS',
      label: 'Questions',
      status:
        evidence.questions.open > 0 ? 'NEEDS_ATTENTION' : hasMaterials ? 'COMPLETE' : 'NOT_STARTED',
      summary:
        evidence.questions.open > 0
          ? `${plural(evidence.questions.open, 'focused question')} are waiting for the right person.`
          : 'No focused questions are waiting for you.',
    },
    {
      id: 'PREVIEW',
      label: 'Preview',
      status:
        evidence.preview.state === 'SUPERSEDED'
          ? 'NEEDS_ATTENTION'
          : previewAvailable
            ? 'AVAILABLE'
            : 'NOT_STARTED',
      summary: previewAvailable
        ? 'Try realistic visitor questions and leave durable feedback.'
        : evidence.preview.state === 'SUPERSEDED'
          ? 'A newer review is needed before this preview can be used.'
          : 'A preview will appear after a candidate package is reviewed.',
    },
    {
      id: 'READINESS',
      label: 'Readiness',
      status: evidence.release.released
        ? 'COMPLETE'
        : qaNeedsAttention
          ? 'NEEDS_ATTENTION'
          : qaComplete
            ? 'AVAILABLE'
            : 'NOT_STARTED',
      summary: evidence.release.released
        ? 'The exact reviewed release is live and remains traceable.'
        : 'Readiness keeps content, confidence, questions, QA, review, and release separate.',
    },
  ]

  const readiness: RemoteOnboardingProjection['readiness'] = [
    {
      id: 'CONTENT',
      label: 'Content completeness',
      status: evidence.release.hasReviewedArtifact
        ? 'READY'
        : reviewAvailable
          ? 'IN_PROGRESS'
          : 'NOT_ASSESSED',
      summary: evidence.release.hasReviewedArtifact
        ? 'A reviewed candidate artifact exists.'
        : 'A reviewed candidate has not been established yet.',
    },
    {
      id: 'SOURCES',
      label: 'Source confidence',
      status:
        evidence.materials.needsAttention > 0
          ? 'NEEDS_ATTENTION'
          : evidence.materials.checking > 0
            ? 'IN_PROGRESS'
            : hasMaterials
              ? 'READY'
              : 'NOT_ASSESSED',
      summary:
        evidence.materials.needsAttention > 0
          ? 'At least one source did not pass verification.'
          : hasMaterials
            ? 'Shared sources are retained with provenance and safe verification state.'
            : 'No source evidence has been shared yet.',
    },
    {
      id: 'QUESTIONS',
      label: 'Missing information',
      status:
        evidence.questions.open > 0 ? 'NEEDS_ATTENTION' : hasMaterials ? 'READY' : 'NOT_ASSESSED',
      summary:
        evidence.questions.open > 0
          ? `${plural(evidence.questions.open, 'question')} still ${evidence.questions.open === 1 ? 'needs' : 'need'} an answer.`
          : 'No client-visible missing-information questions are open.',
    },
    {
      id: 'AUTOMATED_QA',
      label: 'Automated QA',
      status: qaNeedsAttention
        ? 'NEEDS_ATTENTION'
        : qaComplete
          ? 'READY'
          : evidence.qa.state === 'RUNNING' || evidence.qa.state === 'QUEUED'
            ? 'IN_PROGRESS'
            : 'NOT_ASSESSED',
      summary: qaComplete
        ? `${evidence.qa.passed} passed; ${evidence.qa.failed} failed; ${evidence.qa.operationalIssues} could not be scored.${(evidence.qa.safetyCriticalFailed ?? 0) > 0 ? ` ${evidence.qa.safetyCriticalFailed} safety-critical failure(s) block release.` : ''}`
        : evidence.qa.state === 'COMPLETED' && !qaCoverageComplete
          ? `${evidence.qa.assessedDimensions} of ${evidence.qa.requiredDimensions} required onboarding dimensions have terminal evidence for the exact approved package.`
          : evidence.qa.state === 'FAILED'
            ? 'The latest QA run failed operationally and can be retried safely.'
            : evidence.qa.state === 'RUNNING' || evidence.qa.state === 'QUEUED'
              ? 'A frozen QA run is in progress.'
              : 'No completed QA run is available yet.',
    },
    {
      id: 'CLIENT_REVIEW',
      label: 'Client review',
      status: previewAvailable
        ? 'IN_PROGRESS'
        : evidence.release.released
          ? 'READY'
          : 'NOT_ASSESSED',
      summary: previewAvailable
        ? 'A preview is available for client feedback.'
        : evidence.release.released
          ? 'The released artifact retains its review lineage.'
          : 'Client preview has not started.',
    },
    {
      id: 'RELEASE',
      label: 'Publication readiness',
      status: evidence.release.released ? 'READY' : 'NOT_ASSESSED',
      summary: evidence.release.released
        ? 'Release evidence exists for the reviewed artifact.'
        : 'Publication remains a separate, explicit operator action.',
    },
  ]

  return { version: REMOTE_ONBOARDING_PROJECTION_VERSION, primaryAction, stages, readiness }
}
