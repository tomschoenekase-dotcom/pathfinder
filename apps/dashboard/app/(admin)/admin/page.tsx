export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../lib/admin-caller'
import { getJobStatusClasses, getStatusClasses } from '../../../lib/admin-status'

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number | string
  hint?: string
}) {
  return (
    <div className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-pf-deep/40">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">{value}</p>
      {hint ? <p className="mt-1 text-xs text-pf-deep/50">{hint}</p> : null}
    </div>
  )
}

export default async function AdminOverviewPage() {
  const caller = await createAdminCaller()
  const [overview, clients] = await Promise.all([
    caller.admin.overview(),
    caller.admin.listClients(),
  ])

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Platform admin
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">Overview</h1>
        <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">
          Health of every venue operator on the platform.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Clients"
          value={overview.tenants.total}
          hint={`${overview.tenants.byStatus.ACTIVE} active · ${overview.tenants.byStatus.TRIAL} trial · ${overview.tenants.byStatus.SUSPENDED} suspended`}
        />
        <StatCard label="Venues" value={overview.content.venueCount} hint="active" />
        <StatCard label="Points of interest" value={overview.content.placeCount} hint="active" />
        <StatCard
          label="Failed jobs (7d)"
          value={overview.jobs.failed7d}
          hint="across all queues"
        />
        <StatCard label="Sessions (7d)" value={overview.engagement7d.sessions} />
        <StatCard label="Messages (7d)" value={overview.engagement7d.messages} />
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Clients</h2>
          <span className="text-sm text-pf-deep/50">{clients.length} total</span>
        </div>

        {clients.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm">
            <h3 className="text-xl font-semibold text-pf-deep">No clients yet</h3>
            <p className="mt-2 text-sm text-pf-deep/60">
              When a venue operator signs up, they will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {clients.map((client) => {
              const ownerEmail =
                client.memberships.find((membership) => membership.role === 'OWNER')?.user.email ??
                'No owner'

              return (
                <Link
                  key={client.id}
                  href={`/admin/clients/${client.id}`}
                  className="flex flex-col gap-3 rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm transition hover:border-pf-accent sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-lg font-semibold tracking-tight text-pf-deep">
                        {client.name}
                      </h3>
                      <span
                        className={`inline-flex rounded-full border px-3 py-0.5 text-xs font-semibold uppercase tracking-wider ${getStatusClasses(client.status)}`}
                      >
                        {client.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-pf-deep/50">
                      <span className="rounded-full bg-pf-surface px-2 py-0.5 font-mono">
                        {client.slug}
                      </span>
                      <span>{client.memberships.length} members</span>
                      <span>{ownerEmail}</span>
                    </div>
                  </div>
                  <span className="text-sm font-medium text-pf-primary">Manage →</span>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Recent jobs</h2>
        {overview.jobs.recent.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            No job runs recorded yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-pf-light bg-pf-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
                <tr>
                  <th className="px-4 py-3 font-semibold">Queue</th>
                  <th className="px-4 py-3 font-semibold">Job</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {overview.jobs.recent.map((job) => (
                  <tr key={job.id} className="border-b border-pf-light/60 last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-pf-deep/70">{job.queue}</td>
                    <td className="px-4 py-3 text-pf-deep/70">
                      {job.jobName}
                      {job.error ? (
                        <span className="mt-1 block max-w-md truncate text-xs text-rose-600">
                          {job.error}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${getJobStatusClasses(job.status)}`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-pf-deep/50">
                      {job.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
