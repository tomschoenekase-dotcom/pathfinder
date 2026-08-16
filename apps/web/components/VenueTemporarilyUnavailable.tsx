import Link from 'next/link'

import { TorchicoIcon } from '@pathfinder/ui'
import { VenueRetryButton } from './VenueRetryButton'

export function VenueTemporarilyUnavailable({ showHomeLink = true }: { showHomeLink?: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6">
      <section className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
        <TorchicoIcon className="mx-auto h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-pf-deep">
          Guide temporarily unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/60">
          This venue guide is temporarily unavailable. Please try again later.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <VenueRetryButton />
          {showHomeLink ? (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
            >
              Back to home
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  )
}
