export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { WeeklyReportEditor } from '../../../../../../../../../components/admin/WeeklyReportEditor'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

type AdminReportDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string; reportId: string }>
}

export default async function AdminReportDetailPage({ params }: AdminReportDetailPageProps) {
  const { tenantId, venueId, reportId } = await params
  const caller = await createAdminCaller()
  const report = await caller.admin.getWeeklyReport({ tenantId, reportId })

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}/reports`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to reports
      </Link>

      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">{report.title}</h1>
        <p className="mt-2 text-sm text-pf-deep/60">
          {report.weekStart.toLocaleDateString()} to {report.weekEnd.toLocaleDateString()} -{' '}
          {report.status}
        </p>
      </header>

      {report.status === 'GENERATING' ? (
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 text-sm text-pf-deep/60 shadow-sm">
          Generating. Reload this page in a moment.
        </div>
      ) : report.status === 'FAILED' ? (
        <div className="space-y-4 rounded-3xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-700 shadow-sm">
          <p>{report.error ?? 'Report generation failed.'}</p>
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/reports`}
            className="font-semibold text-rose-800 underline"
          >
            Try again from the reports list
          </Link>
        </div>
      ) : (
        <WeeklyReportEditor
          tenantId={tenantId}
          reportId={report.id}
          initialTitle={report.title}
          initialContent={report.content ?? ''}
          status={report.status}
        />
      )}
    </div>
  )
}
