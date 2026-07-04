export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminGenerateWeeklyReportButton } from '../../../../../../../../components/admin/AdminGenerateWeeklyReportButton'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

type AdminReportsPageProps = {
  params: Promise<{ tenantId: string; venueId: string }>
  searchParams: Promise<{ weekStart?: string; weekEnd?: string }>
}

function defaultRangeStart() {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - 6)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function toInputDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

export default async function AdminReportsPage({ params, searchParams }: AdminReportsPageProps) {
  const { tenantId, venueId } = await params
  const query = await searchParams
  const caller = await createAdminCaller()
  const reports = await caller.admin.listWeeklyReports({ tenantId, venueId })
  const fallbackStart = defaultRangeStart()
  const weekStartDate = query.weekStart
    ? new Date(`${query.weekStart}T00:00:00.000Z`)
    : fallbackStart
  const weekEndDate = query.weekEnd ? new Date(`${query.weekEnd}T23:59:59.999Z`) : new Date()

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
        />
      </section>

      <section className="overflow-hidden rounded-2xl border border-pf-light bg-pf-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
            <tr>
              <th className="px-4 py-3 font-semibold">Date range</th>
              <th className="px-4 py-3 font-semibold">Title</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-pf-deep/60">
                  No reports yet.
                </td>
              </tr>
            ) : (
              reports.map((report) => (
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
                  <td className="px-4 py-3 text-pf-deep/70">{report.status}</td>
                  <td className="px-4 py-3 text-pf-deep/50">{report.updatedAt.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
