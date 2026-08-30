import type { ComponentProps } from 'react'
import { notFound } from 'next/navigation'

import {
  resolveClientPortalLifecycle,
  type ClientPortalLifecycleEvidence,
} from '@pathfinder/contracts/client-portal-lifecycle'
import {
  resolveRemoteOnboardingProjection,
  type RemoteOnboardingEvidence,
} from '@pathfinder/contracts/remote-onboarding'

import { RemoteOnboardingJourney } from '../../../components/RemoteOnboardingJourney'
import { TRPCProvider } from '../../../lib/trpc'

const FIXTURE_STATES = [
  'welcome',
  'share',
  'processing',
  'attention',
  'check-recovery',
  'questions',
  'ready',
] as const
type FixtureState = (typeof FIXTURE_STATES)[number]
type JourneyProps = ComponentProps<typeof RemoteOnboardingJourney>

const EMPTY_PACKAGE_COUNTS = { draft: 0, approved: 0, applied: 0, reverted: 0 }
const EMPTY_MATERIALS = {
  uploaded: 0,
  checking: 0,
  checksNeedAction: 0,
  checksWaitingOnTorchiko: 0,
  needsAttention: 0,
  readyForReview: 0,
  processed: 0,
}
const EMPTY_QA: RemoteOnboardingEvidence['qa'] = {
  state: 'NOT_RUN',
  passed: 0,
  failed: 0,
  operationalIssues: 0,
  requiredDimensions: 7,
  assessedDimensions: 0,
  exactPackage: false,
}

function fixtureState(value: string | string[] | undefined): FixtureState {
  const candidate = Array.isArray(value) ? value[0] : value
  return FIXTURE_STATES.includes(candidate as FixtureState)
    ? (candidate as FixtureState)
    : 'welcome'
}

function lifecycleEvidence(
  overrides: Partial<ClientPortalLifecycleEvidence> = {},
): ClientPortalLifecycleEvidence {
  return {
    isActive: false,
    publicContentCount: 0,
    wasLive: false,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: EMPTY_PACKAGE_COUNTS,
    hasActiveOffboarding: false,
    ...overrides,
  }
}

function scenario(state: FixtureState): {
  data: JourneyProps['data']
  uploads: NonNullable<JourneyProps['uploads']>
} {
  const sharedUploads: NonNullable<JourneyProps['uploads']> = [
    {
      id: 'fixture-guide',
      displayName: 'Visitor guide.pdf',
      fileName: 'visitor-guide.pdf',
      mimeType: 'application/pdf',
      byteSize: 2_460_000,
      category: 'DOCUMENT',
      status: 'AWAITING_REVIEW',
    },
    {
      id: 'fixture-entrance',
      displayName: 'Main entrance.jpg',
      fileName: 'main-entrance.jpg',
      mimeType: 'image/jpeg',
      byteSize: 1_380_000,
      category: 'PHOTO',
      status: 'AWAITING_REVIEW',
    },
  ]

  const stateEvidence: Record<
    FixtureState,
    {
      lifecycle: ClientPortalLifecycleEvidence
      materials: RemoteOnboardingEvidence['materials']
      review: RemoteOnboardingEvidence['review']
      questions: JourneyProps['data']['questions']
      preview: RemoteOnboardingEvidence['preview']
      qa: RemoteOnboardingEvidence['qa']
      release: RemoteOnboardingEvidence['release']
      uploads: NonNullable<JourneyProps['uploads']>
      materialTypes?: JourneyProps['data']['materialTypes']
    }
  > = {
    welcome: {
      lifecycle: lifecycleEvidence(),
      materials: EMPTY_MATERIALS,
      review: { proposedSources: 0, draftPackages: 0 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: [],
    },
    share: {
      lifecycle: lifecycleEvidence({ collectingSourceCount: 2 }),
      materials: { ...EMPTY_MATERIALS, readyForReview: 2 },
      review: { proposedSources: 0, draftPackages: 0 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: sharedUploads,
      materialTypes: { DOCUMENT: 1, PHOTO: 1 },
    },
    processing: {
      lifecycle: lifecycleEvidence({ processingSourceCount: 2 }),
      materials: { ...EMPTY_MATERIALS, checking: 2, processed: 1 },
      review: { proposedSources: 0, draftPackages: 0 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: sharedUploads.map((upload) => ({
        ...upload,
        status: 'VERIFYING',
        clientVerification: {
          kind: 'IN_PROGRESS' as const,
          required: false,
          actionLabel: null,
          reason: 'Torchiko is actively checking this saved file.',
          retrySameSubmission: false,
        },
      })),
      materialTypes: { DOCUMENT: 1, PHOTO: 1 },
    },
    attention: {
      lifecycle: lifecycleEvidence({ collectingSourceCount: 1, reviewSourceCount: 1 }),
      materials: { ...EMPTY_MATERIALS, needsAttention: 1, readyForReview: 1 },
      review: { proposedSources: 0, draftPackages: 0 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: [
        sharedUploads[0]!,
        {
          ...sharedUploads[1],
          id: 'fixture-rejected-floor-plan',
          displayName: 'Visitor floor plan.pdf',
          fileName: 'visitor-floor-plan.pdf',
          mimeType: 'application/pdf',
          byteSize: 1_380_000,
          category: 'FLOOR_PLAN',
          status: 'REJECTED',
          rejectionCode: 'UNSAFE_FILE',
        },
      ],
      materialTypes: { DOCUMENT: 1, FLOOR_PLAN: 1 },
    },
    'check-recovery': {
      lifecycle: lifecycleEvidence({ processingSourceCount: 2 }),
      materials: {
        ...EMPTY_MATERIALS,
        checksNeedAction: 1,
        checksWaitingOnTorchiko: 1,
      },
      review: { proposedSources: 0, draftPackages: 0 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: [
        {
          ...sharedUploads[0]!,
          status: 'VERIFYING',
          clientVerification: {
            kind: 'RESUME_CHECK',
            required: true,
            actionLabel: 'Resume file check',
            reason: 'The saved file check stopped before it finished.',
            retrySameSubmission: true,
          },
        },
        {
          ...sharedUploads[1]!,
          status: 'PRECHECK_PASSED',
          clientVerification: {
            kind: 'WAIT_FOR_TORCHIKO',
            required: false,
            actionLabel: null,
            reason: 'The saved file is waiting for Torchiko to finish its security check.',
            retrySameSubmission: false,
          },
        },
      ],
      materialTypes: { DOCUMENT: 1, PHOTO: 1 },
    },
    questions: {
      lifecycle: lifecycleEvidence({ reviewSourceCount: 1, intakeProposalCount: 2 }),
      materials: { ...EMPTY_MATERIALS, processed: 3 },
      review: { proposedSources: 2, draftPackages: 0 },
      questions: {
        open: 1,
        items: [
          {
            requestId: 'fixture-accessible-entrance',
            subject: 'Accessible entrance details',
            prompts: [
              'Which entrance provides the step-free route?',
              'Is that entrance available during every public hour?',
            ],
            additionalPromptCount: 0,
          },
        ],
        additionalQuestionCount: 0,
      },
      preview: { state: 'UNAVAILABLE', packageId: null },
      qa: EMPTY_QA,
      release: { hasReviewedArtifact: false, released: false },
      uploads: sharedUploads,
      materialTypes: { DOCUMENT: 1, PHOTO: 1, STAFF_INTERVIEW: 1 },
    },
    ready: {
      lifecycle: lifecycleEvidence({
        packageCounts: { ...EMPTY_PACKAGE_COUNTS, applied: 1 },
      }),
      materials: { ...EMPTY_MATERIALS, processed: 4 },
      review: { proposedSources: 3, draftPackages: 1 },
      questions: { open: 0, items: [], additionalQuestionCount: 0 },
      preview: { state: 'AVAILABLE', packageId: 'fixture-reviewed-package' },
      qa: {
        state: 'COMPLETED',
        passed: 7,
        failed: 0,
        operationalIssues: 0,
        requiredDimensions: 7,
        assessedDimensions: 7,
        exactPackage: true,
      },
      release: { hasReviewedArtifact: true, released: false },
      uploads: sharedUploads,
      materialTypes: { DOCUMENT: 1, PHOTO: 2, STAFF_INTERVIEW: 1 },
    },
  }

  const fixture = stateEvidence[state]
  const lifecycle = resolveClientPortalLifecycle(fixture.lifecycle)
  const projection = resolveRemoteOnboardingProjection({
    lifecycle,
    materials: fixture.materials,
    review: fixture.review,
    questions: { open: fixture.questions.open },
    preview: fixture.preview,
    qa: fixture.qa,
    release: fixture.release,
  })

  return {
    data: {
      venue: { id: 'fixture-great-lakes-museum', name: 'Great Lakes Discovery Museum' },
      lifecycle,
      projection,
      materials: fixture.materials,
      ...(fixture.materialTypes ? { materialTypes: fixture.materialTypes } : {}),
      review: fixture.review,
      questions: fixture.questions,
      preview: fixture.preview,
      qa: fixture.qa,
      release: fixture.release,
      publication: {
        clientCanPublish: false,
        summary: 'Publication remains a separate, explicit Torchiko operator action.',
      },
    },
    uploads: fixture.uploads,
  }
}

export default async function RemoteOnboardingVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const state = fixtureState((await searchParams).state)
  const fixture = scenario(state)

  return (
    <div data-fixture="remote-onboarding" data-fixture-state={state}>
      <TRPCProvider scopeKey={`fixture:onboarding:${state}`}>
        <RemoteOnboardingJourney data={fixture.data} uploads={fixture.uploads} />
      </TRPCProvider>
    </div>
  )
}
