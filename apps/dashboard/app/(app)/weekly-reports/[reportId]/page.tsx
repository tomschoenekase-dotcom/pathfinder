export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { WeeklyReportContent } from '../../../../components/WeeklyReportContent'
import { createDashboardCaller } from '../../../../lib/server-caller'

type WeeklyReportDetailPageProps = {
  params: Promise<{ reportId: string }>
  searchParams: Promise<{ venue?: string | string[] }>
}

export default async function WeeklyReportDetailPage({
  params,
  searchParams,
}: WeeklyReportDetailPageProps) {
  const [{ reportId }, { venue }] = await Promise.all([params, searchParams])
  const venueId = Array.isArray(venue) ? venue[0] : venue
  if (!venueId) notFound()

  const caller = await createDashboardCaller(`/weekly-reports/${reportId}`)
  let report
  try {
    report = await caller.analytics.getPublishedWeeklyReport({ venueId, reportId })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'NOT_FOUND'
    ) {
      notFound()
    }
    throw error
  }

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <article className="mx-auto max-w-3xl rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm sm:p-10">
        <Link
          href={`/weekly-reports?venue=${encodeURIComponent(venueId)}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Back to reports
        </Link>
        <header className="mt-5 border-b border-pf-light pb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">{report.title}</h1>
          <p className="mt-3 text-sm text-pf-deep/65">
            {report.weekStart.toLocaleDateString()} to {report.weekEnd.toLocaleDateString()}
            {report.publishedAt ? ` · Published ${report.publishedAt.toLocaleDateString()}` : ''}
          </p>
        </header>
        <section aria-label="Weekly report" className="mt-7">
          <WeeklyReportContent content={report.content ?? ''} />
        </section>
      </article>
    </main>
  )
}
