export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createDashboardCaller } from '../../../lib/server-caller'

type WeeklyReportsPageProps = {
  searchParams: Promise<{ venue?: string | string[] }>
}

export default async function WeeklyReportsPage({ searchParams }: WeeklyReportsPageProps) {
  const { venue: requestedVenue } = await searchParams
  const caller = await createDashboardCaller('/weekly-reports')
  const venues = await caller.venue.list()

  if (venues.length === 0) {
    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
        <div className="mx-auto max-w-6xl space-y-8">
          <section>
            <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Weekly Reports</h1>
            <p className="mt-3 text-sm leading-6 text-pf-deep/60">
              Published weekly reports will appear here.
            </p>
          </section>
          <section className="rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-pf-deep">Create a venue first.</h2>
            <Link
              href="/venues/new"
              className="mt-6 inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
            >
              Create a venue
            </Link>
          </section>
        </div>
      </main>
    )
  }

  const venueQuery = Array.isArray(requestedVenue) ? requestedVenue[0] : requestedVenue
  const selectedVenueId = venues.some((venue) => venue.id === venueQuery)
    ? venueQuery!
    : venues[0]!.id
  const reports = await caller.analytics.listPublishedWeeklyReports({ venueId: selectedVenueId })

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-8">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Weekly Reports</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-deep/60">
            Published summaries from PathFinder review.
          </p>
        </section>

        <form className="rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm">
          <label className="grid max-w-md gap-2 text-sm font-medium text-pf-deep">
            Venue
            <select
              name="venue"
              defaultValue={selectedVenueId}
              className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-3"
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="mt-4 inline-flex min-h-10 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white"
          >
            View reports
          </button>
        </form>

        {reports.length === 0 ? (
          <section className="rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <p className="text-lg font-semibold text-pf-deep">No weekly reports published yet.</p>
          </section>
        ) : (
          <section className="space-y-5">
            {reports.map((report) => (
              <article
                key={report.id}
                className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
                      {report.title}
                    </h2>
                    <p className="mt-1 text-sm text-pf-deep/50">
                      {report.weekStart.toLocaleDateString()} to{' '}
                      {report.weekEnd.toLocaleDateString()}
                    </p>
                  </div>
                  {report.publishedAt ? (
                    <span className="text-xs font-semibold uppercase tracking-wider text-pf-deep/40">
                      Published {report.publishedAt.toLocaleDateString()}
                    </span>
                  ) : null}
                </div>
                <pre className="mt-5 whitespace-pre-wrap rounded-[1.5rem] bg-pf-surface p-5 font-sans text-sm leading-6 text-pf-deep/75">
                  {report.content}
                </pre>
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}
