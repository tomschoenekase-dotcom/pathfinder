import { notFound } from 'next/navigation'

import {
  resolveClientPortalLifecycle,
  type ClientPortalLifecycleEvidence,
} from '@pathfinder/contracts/client-portal-lifecycle'

import { DashboardOverviewView } from '../../../components/DashboardOverview'

const FIXTURE_STATES = ['live', 'paused'] as const
type FixtureState = (typeof FIXTURE_STATES)[number]

function fixtureState(value: string | string[] | undefined): FixtureState {
  const candidate = Array.isArray(value) ? value[0] : value
  return FIXTURE_STATES.includes(candidate as FixtureState) ? (candidate as FixtureState) : 'live'
}

function lifecycleEvidence(state: FixtureState): ClientPortalLifecycleEvidence {
  const base = {
    publicContentCount: 14,
    collectingSourceCount: 0,
    processingSourceCount: 0,
    reviewSourceCount: 0,
    intakeProposalCount: 0,
    packageCounts: { draft: 0, approved: 0, applied: 1, reverted: 0 },
    hasActiveOffboarding: false,
  }

  return state === 'paused'
    ? { ...base, isActive: false, wasLive: true }
    : { ...base, isActive: true, wasLive: true }
}

export default async function PortalHomeVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()

  const state = fixtureState((await searchParams).state)
  const lifecycle = resolveClientPortalLifecycle(lifecycleEvidence(state))

  return (
    <main data-fixture="portal-home" data-fixture-state={state}>
      <DashboardOverviewView
        venue={{
          id: 'fixture-great-lakes-museum',
          name: 'Great Lakes Discovery Museum',
          lifecycle,
        }}
        venues={[{ id: 'fixture-great-lakes-museum', name: 'Great Lakes Discovery Museum' }]}
        activeUpdates={state === 'live' ? 2 : 0}
        visitorPulse={{
          windowDays: 30,
          conversationCount: state === 'live' ? 128 : 34,
          feedback: { helpful: state === 'live' ? 47 : 11, notHelpful: state === 'live' ? 5 : 2 },
        }}
        chatUrl="https://example.test/great-lakes-discovery-museum"
        impersonatedTenantName="Great Lakes Discovery Museum"
      />
    </main>
  )
}
