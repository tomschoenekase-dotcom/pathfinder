import Link from 'next/link'

import { PathFinderIcon } from '../components/PathFinderBrand'

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
      <div className="max-w-md space-y-4 rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
        <PathFinderIcon className="mx-auto h-12 w-12" />
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Venue not found</h1>
        <p className="text-sm leading-6 text-pf-deep/60">
          Check the venue link and try again. This public app only serves active venues.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
        >
          Back to PathFinder
        </Link>
      </div>
    </main>
  )
}
