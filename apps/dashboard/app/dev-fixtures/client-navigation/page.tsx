import { notFound } from 'next/navigation'

import {
  resolveClientPortalLifecycle,
  type ClientPortalLifecycleEvidence,
} from '@pathfinder/contracts/client-portal-lifecycle'
import { resolveRemoteOnboardingProjection } from '@pathfinder/contracts/remote-onboarding'

import { DashboardOverviewView } from '../../../components/DashboardOverview'
import { RemoteOnboardingJourney } from '../../../components/RemoteOnboardingJourney'
import { SupportWorkspace } from '../../../components/SupportWorkspace'
import { VenueQrKit } from '../../../components/VenueQrKit'
import { ClientNavigationFixture } from './ClientNavigationFixture'

const VENUE_ID = 'fixture-great-lakes-museum'
const ONBOARDING = `/venues/${VENUE_ID}/onboarding`
const SUPPORT = `/support?venue=${VENUE_ID}&returnTo=${encodeURIComponent(ONBOARDING)}`
const TODAY = `/?venue=${VENUE_ID}`
const QR = `/venues/${VENUE_ID}/qr-kit`
const ALLOWED_TARGETS = new Set([ONBOARDING, SUPPORT, TODAY, QR])

const liveEvidence: ClientPortalLifecycleEvidence = {
  isActive: true,
  publicContentCount: 12,
  wasLive: true,
  collectingSourceCount: 0,
  processingSourceCount: 0,
  reviewSourceCount: 0,
  intakeProposalCount: 0,
  packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
  hasActiveOffboarding: false,
}

function onboarding() {
  const lifecycle = resolveClientPortalLifecycle({
    ...liveEvidence,
    isActive: false,
    wasLive: false,
    publicContentCount: 0,
    collectingSourceCount: 1,
    packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
  })
  const materials = {
    uploaded: 0,
    checking: 0,
    checksNeedAction: 0,
    checksWaitingOnTorchiko: 0,
    needsAttention: 0,
    readyForReview: 1,
    processed: 0,
  }
  const review = { proposedSources: 0, draftPackages: 0 }
  const preview = { state: 'UNAVAILABLE' as const, packageId: null }
  const qa = {
    state: 'NOT_RUN' as const,
    passed: 0,
    failed: 0,
    operationalIssues: 0,
    requiredDimensions: 7,
    assessedDimensions: 0,
    exactPackage: false,
  }
  const release = { hasReviewedArtifact: false, released: false }
  return (
    <RemoteOnboardingJourney
      ownerId="fixture-owner"
      data={{
        venue: { id: VENUE_ID, name: 'Great Lakes Discovery Museum', category: 'Museum' },
        lifecycle,
        projection: resolveRemoteOnboardingProjection({
          lifecycle,
          materials,
          review,
          questions: { open: 0 },
          preview,
          qa,
          release,
        }),
        materials,
        review,
        questions: { open: 0, items: [], additionalQuestionCount: 0 },
        preview,
        qa,
        release,
        publication: {
          clientCanPublish: false,
          summary: 'Publication remains a separate Torchiko operator action.',
        },
      }}
    />
  )
}

function content(target: string) {
  if (target === ONBOARDING) return onboarding()
  if (target === SUPPORT)
    return (
      <SupportWorkspace
        venues={[
          { id: 'fixture-river-archive', name: 'River Archive' },
          { id: VENUE_ID, name: 'Great Lakes Discovery Museum' },
        ]}
        activeVenue={{ id: VENUE_ID, name: 'Great Lakes Discovery Museum' }}
        initialRequests={[]}
        initialNextCursor={null}
        initialDetail={null}
        initialEligibleAttachments={[]}
        initialEligibleAttachmentsNextCursor={null}
        returnHref={ONBOARDING}
      />
    )
  if (target === QR)
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-7 sm:py-12">
        <VenueQrKit
          audience="client"
          venueName="Great Lakes Discovery Museum"
          guestChatUrl="https://guide.example.com/great-lakes-discovery-museum/chat"
          generatedAt="2026-09-08T12:00:00.000Z"
        />
      </div>
    )
  const lifecycle = resolveClientPortalLifecycle(liveEvidence)
  return (
    <DashboardOverviewView
      venue={{ id: VENUE_ID, name: 'Great Lakes Discovery Museum', lifecycle }}
      venues={[
        { id: 'fixture-river-archive', name: 'River Archive' },
        { id: VENUE_ID, name: 'Great Lakes Discovery Museum' },
      ]}
      activeUpdates={0}
      chatUrl="https://guide.example.com/great-lakes-discovery-museum/chat"
    />
  )
}

export default async function ClientNavigationPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()
  const raw = (await searchParams).target
  const target = Array.isArray(raw) ? raw[0] : raw
  const selected = target && ALLOWED_TARGETS.has(target) ? target : ONBOARDING
  return <ClientNavigationFixture target={selected}>{content(selected)}</ClientNavigationFixture>
}
