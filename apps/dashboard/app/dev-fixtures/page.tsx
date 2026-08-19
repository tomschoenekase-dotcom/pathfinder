import Link from 'next/link'
import { notFound } from 'next/navigation'

const onboardingStates = ['welcome', 'share', 'processing', 'questions', 'ready'] as const
const portalStates = ['live', 'paused'] as const
const uploadStates = ['selected', 'uploading', 'error', 'joined'] as const
const clientTochiStates = [
  'empty',
  'history',
  'handoff',
  'failure',
  'minimized',
  'disabled',
] as const
const venueBotStates = ['classic', 'custom', 'character'] as const

export default function VisualFixtureIndex() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-5 py-12 text-pf-deep">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary">
        Development only
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Torchiko visual fixtures</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
        Deterministic component states for responsive, accessibility, motion, and screenshot QA.
        These routes do not read or alter production client data.
      </p>

      <section
        className="mt-10 border-t border-pf-light pt-6"
        aria-labelledby="onboarding-fixtures"
      >
        <h2 id="onboarding-fixtures" className="text-xl font-semibold">
          Remote onboarding
        </h2>
        <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
          {onboardingStates.map((state) => (
            <li key={state}>
              <Link
                href={`/dev-fixtures/remote-onboarding?state=${state}`}
                className="flex min-h-12 items-center justify-between py-3 font-medium capitalize text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {state}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="mt-10 border-t border-pf-light pt-6"
        aria-labelledby="client-tochi-fixtures"
      >
        <h2 id="client-tochi-fixtures" className="text-xl font-semibold">
          Client Tochi
        </h2>
        <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
          {clientTochiStates.map((state) => (
            <li key={state}>
              <Link
                href={`/dev-fixtures/client-tochi?state=${state}`}
                className="flex min-h-12 items-center justify-between py-3 font-medium capitalize text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {state}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 border-t border-pf-light pt-6" aria-labelledby="portal-fixtures">
        <h2 id="portal-fixtures" className="text-xl font-semibold">
          Portal home
        </h2>
        <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
          {portalStates.map((state) => (
            <li key={state}>
              <Link
                href={`/dev-fixtures/portal-home?state=${state}`}
                className="flex min-h-12 items-center justify-between py-3 font-medium capitalize text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {state}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 border-t border-pf-light pt-6" aria-labelledby="venue-bot-fixtures">
        <h2 id="venue-bot-fixtures" className="text-xl font-semibold">
          Venue Bot settings
        </h2>
        <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
          {venueBotStates.map((state) => (
            <li key={state}>
              <Link
                href={`/dev-fixtures/venue-bot-settings?state=${state}`}
                className="flex min-h-12 items-center justify-between py-3 font-medium capitalize text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {state}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/dev-fixtures/tochi-rollout"
              className="flex min-h-12 items-center justify-between py-3 font-medium text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            >
              Private rollout controls
              <span aria-hidden="true">→</span>
            </Link>
          </li>
        </ul>
      </section>

      <section className="mt-10 border-t border-pf-light pt-6" aria-labelledby="upload-fixtures">
        <h2 id="upload-fixtures" className="text-xl font-semibold">
          Upload interaction
        </h2>
        <ul className="mt-4 divide-y divide-pf-light border-y border-pf-light">
          {uploadStates.map((state) => (
            <li key={state}>
              <Link
                href={`/dev-fixtures/upload-states?state=${state}`}
                className="flex min-h-12 items-center justify-between py-3 font-medium capitalize text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {state}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
