import Link from 'next/link'
import { TorchicoIcon } from '@pathfinder/ui'

import type { VenueChatPresentation } from './venue-chat-types'

export function VenueChatSkeleton() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6" role="status">
      <div className="flex flex-col items-center gap-5 text-center">
        <TorchicoIcon className="h-10 w-10 animate-pulse motion-reduce:animate-none" />
        <p className="text-sm font-medium text-pf-deep/75">Loading your guide...</p>
      </div>
    </main>
  )
}

export function VenueChatError({
  message,
  presentation,
}: {
  message: string
  presentation: VenueChatPresentation
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6">
      <div
        className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm"
        role="alert"
      >
        <h1 className="text-2xl font-semibold text-pf-deep">Venue unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/75">{message}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
          >
            Try again
          </button>
          {presentation === 'standalone' ? (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
            >
              Back to home
            </Link>
          ) : null}
        </div>
      </div>
    </main>
  )
}
