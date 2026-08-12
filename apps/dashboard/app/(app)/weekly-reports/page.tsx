export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createDashboardCaller } from '../../../lib/server-caller'

type WeeklyReportsPageProps = {
  searchParams: Promise<{
    venue?: string | string[]
    cursorDate?: string | string[]
    cursorId?: string | string[]
  }>
}

export default async function WeeklyReportsPage({ searchParams }: WeeklyReportsPageProps) {
  const { venue: requestedVenue, cursorDate, cursorId } = await searchParams
  const caller = await createDashboardCaller('/weekly-reports')
  const [venues, availability] = await Promise.all([
    caller.venue.list(),
    caller.analytics.getWeeklyReportAvailability(),
  ])
  const enabledVenueIds = new Set(availability.enabledVenueIds)
  const enabledVenues = venues.filter((venue) => enabledVenueIds.has(venue.id))

  if (enabledVenues.length === 0) {
    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
        <div className="mx-auto max-w-6xl space-y-8">
          <section>
            <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Weekly Reports</h1>
            <p className="mt-3 text-sm leading-6 text-pf-deep/60">
              Weekly reports have not been enabled for any venue in this workspace.
            </p>
          </section>
          <section className="rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-pf-deep">Reports are disabled.</h2>
            <p className="mt-3 text-sm text-pf-deep/60">
              Your PathFinder administrator can enable reports for a venue after launch review.
            </p>
          </section>
        </div>
      </main>
    )
  }

  const venueQuery = Array.isArray(requestedVenue) ? requestedVenue[0] : requestedVenue
  if (venueQuery && !enabledVenueIds.has(venueQuery)) {
    return (
      <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
        <section className="mx-auto max-w-3xl rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-pf-deep">
            Reports are disabled for this venue.
          </h1>
          <Link
            href="/weekly-reports"
            className="mt-5 inline-flex text-sm font-semibold text-pf-primary"
          >
            View an enabled venue
          </Link>
        </section>
      </main>
    )
  }
  const selectedVenueId = venueQuery ?? enabledVenues[0]!.id
  const cursorDateValue = Array.isArray(cursorDate) ? cursorDate[0] : cursorDate
  const cursorIdValue = Array.isArray(cursorId) ? cursorId[0] : cursorId
  const cursorPartsPresent = Boolean(cursorDateValue || cursorIdValue)
  const cursorIsValid = Boolean(
    cursorDateValue &&
    cursorIdValue &&
    cursorIdValue.length <= 191 &&
    !Number.isNaN(new Date(cursorDateValue).getTime()),
  )
  const cursor =
    cursorIsValid && cursorDateValue && cursorIdValue
      ? { weekStart: new Date(cursorDateValue), id: cursorIdValue }
      : undefined
  const reports = await caller.analytics.listPublishedWeeklyReports({
    venueId: selectedVenueId,
    ...(cursor ? { cursor } : {}),
  })

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
              {enabledVenues.map((venue) => (
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

        {cursorPartsPresent && !cursorIsValid ? (
          <p
            role="status"
            className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          >
            That older-reports link was incomplete or invalid, so the newest reports are shown.
          </p>
        ) : null}

        {reports.items.length === 0 ? (
          <section className="rounded-[2rem] border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <p className="text-lg font-semibold text-pf-deep">No weekly reports published yet.</p>
          </section>
        ) : (
          <section className="space-y-5">
            {reports.items.map((report) => (
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
                <Link
                  href={`/weekly-reports/${report.id}?venue=${encodeURIComponent(selectedVenueId)}`}
                  className="mt-5 inline-flex min-h-11 items-center rounded-full border border-pf-primary px-5 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
                >
                  Read report
                </Link>
              </article>
            ))}
            {reports.nextCursor ? (
              <Link
                href={`/weekly-reports?venue=${encodeURIComponent(selectedVenueId)}&cursorDate=${encodeURIComponent(reports.nextCursor.weekStart.toISOString())}&cursorId=${encodeURIComponent(reports.nextCursor.id)}`}
                className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
              >
                Older reports
              </Link>
            ) : null}
          </section>
        )}
      </div>
    </main>
  )
}
