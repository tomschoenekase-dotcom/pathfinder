export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminGenerateWeeklyReportButton } from '../../../../../../../../../components/admin/AdminGenerateWeeklyReportButton'
import { WeeklyReportEditor } from '../../../../../../../../../components/admin/WeeklyReportEditor'
import { WeeklyReportLifecycleEvidence } from '../../../../../../../../../components/admin/WeeklyReportLifecycleEvidence'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

type AdminReportDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string; reportId: string }>
}

export default async function AdminReportDetailPage({ params }: AdminReportDetailPageProps) {
  const { tenantId, venueId, reportId } = await params
  const caller = await createAdminCaller()
  const [report, lifecycle, reportConfiguration] = await Promise.all([
    caller.admin.getWeeklyReport({ tenantId, venueId, reportId }),
    caller.admin.getWeeklyReportLifecycle({ tenantId, venueId, reportId }).catch(() => null),
    caller.admin.getVenueReportConfiguration({ tenantId, venueId }),
  ])

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

      <WeeklyReportLifecycleEvidence evidence={lifecycle} />

      {report.status === 'GENERATING' ? (
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 text-sm text-pf-deep/60 shadow-sm">
          Generating. Reload this page in a moment.
        </div>
      ) : report.status === 'FAILED' ? (
        <div className="space-y-4 rounded-3xl border border-rose-200 bg-rose-50 p-8 text-sm text-rose-700 shadow-sm">
          <p>{report.error ?? 'Report generation failed.'}</p>
          <p>
            Retry creates a new report request for this exact range. The failed report remains
            immutable evidence.
          </p>
          <AdminGenerateWeeklyReportButton
            tenantId={tenantId}
            venueId={venueId}
            weekStart={report.weekStart.toISOString()}
            weekEnd={report.weekEnd.toISOString()}
            enabled={reportConfiguration.enabled}
            retrySeed={`failed-report:${report.id}`}
          />
        </div>
      ) : (
        <WeeklyReportEditor
          tenantId={tenantId}
          venueId={venueId}
          reportId={report.id}
          initialTitle={report.title}
          initialContent={report.content ?? ''}
          initialUpdatedAt={report.updatedAt.toISOString()}
          status={report.status}
        />
      )}
    </div>
  )
}
