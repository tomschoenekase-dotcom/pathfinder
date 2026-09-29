import { notFound } from 'next/navigation'

import { PortalHomeFixture } from './PortalHomeFixture'

const FIXTURE_STATES = ['live', 'paused'] as const
type FixtureState = (typeof FIXTURE_STATES)[number]

function fixtureState(value: string | string[] | undefined): FixtureState {
  const candidate = Array.isArray(value) ? value[0] : value
  return FIXTURE_STATES.includes(candidate as FixtureState) ? (candidate as FixtureState) : 'live'
}

export default async function PortalHomeVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <PortalHomeFixture state={fixtureState((await searchParams).state)} />
}
