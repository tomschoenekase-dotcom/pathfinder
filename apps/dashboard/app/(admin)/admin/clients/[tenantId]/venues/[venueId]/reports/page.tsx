export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminGenerateWeeklyReportButton } from '../../../../../../../../components/admin/AdminGenerateWeeklyReportButton'
import { AdminVenueReportConfiguration } from '../../../../../../../../components/admin/AdminVenueReportConfiguration'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'
import { resolveAdminReportRouteInput } from '../../../../../../../../lib/admin-report-route-input'

type AdminReportsPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{
    weekStart?: string
    weekEnd?: string
    cursorWeekStart?: string
    cursorId?: string
  }>
}

function toInputDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function simpleStatus(status: 'GENERATING' | 'DRAFT' | 'PUBLISHED' | 'FAILED') {
  if (status === 'GENERATING') return 'In progress'
  if (status === 'DRAFT') return 'Review'
  if (status === 'PUBLISHED') return 'Published'
  return 'Failed'
}

export default async function AdminReportsPage({ params, searchParams }: AdminReportsPageProps) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  const resolvedInput = resolveAdminReportRouteInput(query)
  const hasCompleteCursor = resolvedInput.cursor !== null
  const [reportPage, reportConfiguration] = await Promise.all([
    caller.admin.listWeeklyReports({
      tenantId,
      venueId,
      limit: 25,
      ...(hasCompleteCursor
        ? {
            cursorWeekStart: resolvedInput.cursor!.weekStart,
            cursorId: resolvedInput.cursor!.id,
          }
        : {}),
    }),
    caller.admin.getVenueReportConfiguration({ tenantId, venueId }),
  ])
  const weekStartDate = resolvedInput.weekStart
  const weekEndDate = resolvedInput.weekEnd
  const nextHref = reportPage.nextCursor
    ? `/admin/clients/${tenantId}/venues/${venueId}/reports?${new URLSearchParams({
        weekStart: toInputDate(weekStartDate),
        weekEnd: toInputDate(weekEndDate),
        cursorWeekStart: reportPage.nextCursor.weekStart,
        cursorId: reportPage.nextCursor.id,
      }).toString()}`
    : null

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to venue
      </Link>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Reports</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          Generate, edit, and publish client-facing reports for any date range.
        </p>
      </header>

      {resolvedInput.warning ? (
        <p
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {resolvedInput.warning}
        </p>
      ) : null}

      <AdminVenueReportConfiguration
        tenantId={tenantId}
        venueId={venueId}
        enabled={reportConfiguration.enabled}
        updatedAt={reportConfiguration.updatedAt?.toISOString() ?? null}
      />

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-sm font-medium text-pf-deep">
            Start date
            <input
              type="date"
              name="weekStart"
              defaultValue={toInputDate(weekStartDate)}
              className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-pf-deep">
            End date
            <input
              type="date"
              name="weekEnd"
              defaultValue={toInputDate(weekEndDate)}
              className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-2"
            />
          </label>
          <button
            type="submit"
            className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-semibold text-pf-primary"
          >
            Set date range
          </button>
        </form>
        <AdminGenerateWeeklyReportButton
          tenantId={tenantId}
          venueId={venueId}
          weekStart={weekStartDate.toISOString()}
          weekEnd={weekEndDate.toISOString()}
          enabled={reportConfiguration.enabled}
        />
      </section>

      <section
        aria-labelledby="report-history-heading"
        className="overflow-x-auto rounded-2xl border border-pf-light bg-pf-white shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        tabIndex={0}
      >
        <h2 id="report-history-heading" className="sr-only">
          Report history
        </h2>
        <table className="min-w-[42rem] w-full text-left text-sm">
          <caption className="sr-only">Venue report history</caption>
          <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">
                Date range
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Title
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {reportPage.items.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-pf-deep/60">
                  No reports yet.
                </td>
              </tr>
            ) : (
              reportPage.items.map((report) => (
                <tr key={report.id} className="border-b border-pf-light/60 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/clients/${tenantId}/venues/${venueId}/reports/${report.id}`}
                      className="font-medium text-pf-primary hover:text-pf-accent"
                    >
                      {report.weekStart.toLocaleDateString()} to{' '}
                      {report.weekEnd.toLocaleDateString()}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-pf-deep/70">{report.title}</td>
                  <td className="px-4 py-3 text-pf-deep/70">{simpleStatus(report.status)}</td>
                  <td className="px-4 py-3 text-pf-deep/50">{report.updatedAt.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <nav aria-label="Report history pages" className="flex items-center justify-between gap-3">
        {hasCompleteCursor ? (
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/reports?${new URLSearchParams({
              weekStart: toInputDate(weekStartDate),
              weekEnd: toInputDate(weekEndDate),
            }).toString()}`}
            className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-white px-4 text-sm font-semibold text-pf-primary"
          >
            Back to newest
          </Link>
        ) : (
          <span />
        )}
        {nextHref ? (
          <Link
            href={nextHref}
            className="inline-flex min-h-10 items-center rounded-full bg-pf-primary px-4 text-sm font-semibold text-white"
          >
            Older reports
          </Link>
        ) : null}
      </nav>
    </div>
  )
}
