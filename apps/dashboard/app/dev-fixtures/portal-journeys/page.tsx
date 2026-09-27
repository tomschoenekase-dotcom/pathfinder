import { notFound } from 'next/navigation'

import {
  resolveClientPortalLifecycle,
  type ClientPortalLifecycleEvidence,
} from '@pathfinder/contracts/client-portal-lifecycle'
import { buildVenueAccessArtifacts } from '@pathfinder/contracts/venue-access-artifacts'

import { DashboardOverviewView } from '../../../components/DashboardOverview'
import { buildPortalHomeTasks, type PortalHomeTaskEvidence } from '../../../lib/portal-home-tasks'
import { PortalJourneyShell } from './PortalJourneyShell'

// Synthetic client-portal home states for the five venue jobs: first visit,
// a specific information request, preview/pending review, launch access, and an
// ordinary day with nothing to do. Props are derived exactly as the portal home
// derives them; no client data, network call, or mutation is involved.
const STATES = [
  'first-run',
  'needs-input',
  'preview',
  'pending',
  'launched',
  'quiet',
  'paused',
] as const
type JourneyState = (typeof STATES)[number]

const VENUE = {
  id: 'fixture-maple-hollow',
  name: 'Maple Hollow Nature Center',
  slug: 'maple-hollow',
}
const ORIGIN = 'https://guide.example.com'
const CHAT_URL = `${ORIGIN}/${VENUE.slug}/chat`

const base: ClientPortalLifecycleEvidence = {
  isActive: false,
  publicContentCount: 0,
  wasLive: false,
  collectingSourceCount: 0,
  processingSourceCount: 0,
  reviewSourceCount: 0,
  intakeProposalCount: 0,
  packageCounts: { draft: 0, approved: 0, applied: 0, reverted: 0 },
  hasActiveOffboarding: false,
}
const live = {
  ...base,
  isActive: true,
  wasLive: true,
  publicContentCount: 18,
  packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
}

const EVIDENCE: Record<JourneyState, ClientPortalLifecycleEvidence> = {
  'first-run': base,
  'needs-input': { ...base, reviewSourceCount: 3, intakeProposalCount: 1 },
  preview: { ...base, packageCounts: { draft: 0, approved: 1, applied: 0, reverted: 0 } },
  pending: { ...live, packageCounts: { draft: 1, approved: 0, applied: 1, reverted: 0 } },
  launched: live,
  quiet: live,
  paused: { ...live, isActive: false },
}

const noTasks: PortalHomeTaskEvidence = {
  missingInformation: [],
  additionalMissingRequest: false,
  hasSharedInformation: true,
  latestReport: null,
}

const TASK_EVIDENCE: Record<JourneyState, PortalHomeTaskEvidence> = {
  'first-run': { ...noTasks, hasSharedInformation: false },
  'needs-input': {
    ...noTasks,
    missingInformation: [
      {
        requestId: 'fixture-request-trail-map',
        subject: 'A current trail map',
        items: ['A photo or PDF of the map at the trailhead', 'Which loop is stroller-friendly'],
        additionalItemCount: 0,
      },
      {
        requestId: 'fixture-request-hours',
        subject: 'Winter hours',
        items: ['Opening and closing times from November to March'],
        additionalItemCount: 0,
      },
    ],
  },
  preview: noTasks,
  pending: noTasks,
  launched: noTasks,
  quiet: {
    ...noTasks,
    latestReport: { id: 'fixture-report-sep', title: 'September visitor review' },
  },
  paused: noTasks,
}

function journeyState(value: string | string[] | undefined): JourneyState {
  const candidate = Array.isArray(value) ? value[0] : value
  return STATES.includes(candidate as JourneyState) ? (candidate as JourneyState) : 'first-run'
}

export default async function PortalJourneysFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    notFound()

  const state = journeyState((await searchParams).state)
  const lifecycle = resolveClientPortalLifecycle(EVIDENCE[state])
  const clientPreview =
    state === 'preview'
      ? { state: 'AVAILABLE' as const, id: 'fixture-preview-1' }
      : { state: 'UNAVAILABLE' as const, id: null }
  const tasks = buildPortalHomeTasks({
    venueId: VENUE.id,
    lifecycle,
    clientPreview,
    chatUrl: CHAT_URL,
    evidence: TASK_EVIDENCE[state],
  })
  const artifacts = buildVenueAccessArtifacts(ORIGIN, VENUE.slug, { appBackground: '#fbfaf6' })
  const isLive = state === 'launched' || state === 'quiet' || state === 'paused'

  return (
    <PortalJourneyShell venueId={VENUE.id} state={state}>
      <DashboardOverviewView
        venue={{ id: VENUE.id, name: VENUE.name, lifecycle, clientPreview }}
        venues={[{ id: VENUE.id, name: VENUE.name }]}
        activeUpdates={state === 'quiet' ? 1 : 0}
        chatUrl={CHAT_URL}
        tasks={tasks}
        organizationName={VENUE.name}
        visitorPulse={
          isLive
            ? {
                windowDays: 30,
                conversationCount: state === 'quiet' ? 212 : 0,
                feedback: {
                  helpful: state === 'quiet' ? 64 : 0,
                  notHelpful: state === 'quiet' ? 6 : 0,
                },
              }
            : null
        }
        secondLayer={{
          enabled: false,
          label: 'Staff',
          url: null,
          updatedAt: '2026-09-20T12:00:00.000Z',
        }}
        distributionReadback={{
          website: {
            effective: false,
            reason: 'FLAG_OFF',
            framed: false,
            frameReason: null,
            origins: [],
          },
          app: { effective: false, reason: 'FLAG_OFF' },
          revision: 0,
          sessions30d:
            state === 'quiet'
              ? { direct: 41, qr: 163, website: 0, app: 0, unknown: 8 }
              : { direct: 0, qr: 0, website: 0, app: 0, unknown: 0 },
          publicUrl: artifacts?.publicUrl ?? null,
          appUrl: artifacts?.appUrl ?? null,
          appBackground: artifacts?.appBackground ?? null,
        }}
      />
    </PortalJourneyShell>
  )
}
