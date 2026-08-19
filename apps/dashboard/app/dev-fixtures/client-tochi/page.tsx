import { notFound } from 'next/navigation'

import {
  ClientTochiFixture,
  type ClientTochiFixtureState,
} from '../../../components/ClientTochiFixture'

const STATES: readonly ClientTochiFixtureState[] = [
  'empty',
  'history',
  'handoff',
  'failure',
  'minimized',
  'disabled',
]

function fixtureState(value: string | string[] | undefined): ClientTochiFixtureState {
  const candidate = Array.isArray(value) ? value[0] : value
  return STATES.includes(candidate as ClientTochiFixtureState)
    ? (candidate as ClientTochiFixtureState)
    : 'empty'
}

export default async function ClientTochiVisualFixture({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[] }>
}) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const state = fixtureState((await searchParams).state)

  return (
    <main
      className="min-h-screen bg-pf-surface px-5 py-12 text-pf-deep"
      data-fixture="client-tochi"
      data-fixture-state={state}
    >
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
          Development only
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Client Tochi fixture</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
          Synthetic client-visible content only. This fixture does not read or write tenant data,
          create support requests, or call an AI provider.
        </p>
      </div>
      <ClientTochiFixture state={state} />
    </main>
  )
}
