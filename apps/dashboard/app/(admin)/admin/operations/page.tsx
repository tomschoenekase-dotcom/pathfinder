export const dynamic = 'force-dynamic'

import { Activity, CheckCircle2 } from 'lucide-react'

import { createAdminCaller } from '../../../../lib/admin-caller'
import { getJobStatusClasses } from '../../../../lib/admin-status'

export default async function AdminOperationsPage() {
  const caller = await createAdminCaller()
  const overview = await caller.admin.overview()

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Operations</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Work and failures
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          A focused queue view for recent platform work. Agent runs and approval records will join
          this timeline through the shared operations model.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-sky-700" aria-hidden="true" />
            <h2 className="font-semibold text-slate-950">Recent jobs</h2>
          </div>
          <span
            className={`text-sm font-semibold ${overview.jobs.failed7d ? 'text-rose-700' : 'text-emerald-700'}`}
          >
            {overview.jobs.failed7d} failed in 7 days
          </span>
        </div>
        {overview.jobs.recent.length === 0 ? (
          <div className="p-10 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" aria-hidden="true" />
            <p className="mt-3 text-sm text-slate-600">No job runs recorded.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Recent background jobs and their current status</caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Work</th>
                  <th className="px-5 py-3 font-semibold">Queue</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.jobs.recent.map((job) => (
                  <tr key={job.id}>
                    <td className="px-5 py-4">
                      <p className="font-medium text-slate-900">{job.jobName}</p>
                      {job.error ? (
                        <p className="mt-1 max-w-xl truncate text-xs text-rose-700">{job.error}</p>
                      ) : null}
                    </td>
                    <td className="px-5 py-4 font-mono text-xs text-slate-600">{job.queue}</td>
                    <td className="px-5 py-4">
                      <span
                        className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getJobStatusClasses(job.status)}`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-500">
                      {job.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
