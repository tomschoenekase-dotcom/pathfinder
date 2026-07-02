export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../lib/admin-caller'

type AdminClientAnalyticsPageProps = {
  params: Promise<{ tenantId: string }>
}

type MessageRow = Awaited<
  ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClientAnalytics']>
>['recentSessions'][number]['messages'][number]

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-pf-light bg-pf-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-pf-deep/40">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">{value}</p>
    </div>
  )
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatClusterKind(kind: string): string {
  if (kind === 'content_gap') return 'Content gap'
  if (kind === 'top_question') return 'Top question'
  return kind.replace(/_/g, ' ')
}

function formatVisitor(visitorId: string | null): string {
  if (!visitorId) return 'Anonymous'
  return visitorId.length > 12 ? `${visitorId.slice(0, 12)}...` : visitorId
}

function formatRole(role: MessageRow['role']): string {
  return role === 'user' ? 'GUEST' : 'AI'
}

export default async function AdminClientAnalyticsPage({ params }: AdminClientAnalyticsPageProps) {
  const { tenantId } = await params
  const caller = await createAdminCaller()

  let data: Awaited<
    ReturnType<Awaited<ReturnType<typeof createAdminCaller>>['admin']['getClientAnalytics']>
  >
  try {
    data = await caller.admin.getClientAnalytics({ tenantId })
  } catch {
    return (
      <div className="space-y-6">
        <Link
          href={`/admin/clients/${tenantId}`}
          className="text-sm font-medium text-pf-primary hover:text-pf-accent"
        >
          Back to client
        </Link>
        <div className="rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">Client not found</h1>
          <p className="mt-2 text-sm text-pf-deep/60">This tenant record does not exist.</p>
        </div>
      </div>
    )
  }

  const { tenant, stats, questionClusters, recentSessions } = data

  return (
    <div className="space-y-10">
      <Link
        href={`/admin/clients/${tenant.id}`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to {tenant.name}
      </Link>

      <header className="space-y-3">
        <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">
          {tenant.name} - Analytics
        </h1>
        <p className="text-sm text-pf-deep/50">Last 30 days</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total sessions" value={stats.totalSessions} />
        <StatCard label="Total messages" value={stats.totalMessages} />
        <StatCard label="Unique visitors" value={stats.uniqueVisitors} />
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Question clusters</h2>
        {questionClusters.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            No question clusters found. Run the analytics enrichment job to populate these.
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
                <tr>
                  <th className="px-4 py-3 font-semibold">Question</th>
                  <th className="px-4 py-3 font-semibold">Type</th>
                  <th className="px-4 py-3 font-semibold">Count</th>
                  <th className="px-4 py-3 font-semibold">Venue</th>
                  <th className="px-4 py-3 font-semibold">Window</th>
                </tr>
              </thead>
              <tbody>
                {questionClusters.map((cluster) => (
                  <tr key={cluster.id} className="border-b border-pf-light/60 last:border-0">
                    <td className="max-w-xl px-4 py-3 text-pf-deep">{cluster.canonicalText}</td>
                    <td className="px-4 py-3 text-pf-deep/70">{formatClusterKind(cluster.kind)}</td>
                    <td className="px-4 py-3 text-pf-deep/70">{cluster.count}</td>
                    <td className="px-4 py-3 text-pf-deep/70">{cluster.venue.name}</td>
                    <td className="px-4 py-3 text-pf-deep/70">{formatDate(cluster.windowStart)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Recent conversations</h2>
        {recentSessions.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            No sessions in this period.
          </div>
        ) : (
          <div className="space-y-3">
            {recentSessions.map((session) => (
              <details
                key={session.id}
                className="rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm"
              >
                <summary className="cursor-pointer text-sm font-semibold text-pf-deep">
                  {formatDateTime(session.startedAt)} | {session.messageCount} messages |{' '}
                  {formatVisitor(session.visitorId)}
                </summary>
                <div className="mt-5 space-y-3">
                  {session.messages.length === 0 ? (
                    <p className="text-sm text-pf-deep/60">No messages recorded.</p>
                  ) : (
                    session.messages.map((message) => (
                      <div
                        key={message.id}
                        className="grid gap-3 rounded-2xl border border-pf-light bg-pf-surface p-4 sm:grid-cols-[84px_minmax(0,1fr)_150px]"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wider text-pf-deep/50">
                          {formatRole(message.role)}
                        </span>
                        <p className="whitespace-pre-wrap text-sm leading-6 text-pf-deep">
                          {message.content}
                        </p>
                        <span className="text-xs text-pf-deep/50 sm:text-right">
                          {formatDateTime(message.createdAt)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
