export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { createAdminCaller } from '../../../../../../lib/admin-caller'

type AdminClientAnalyticsPageProps = {
  params: Promise<{ tenantId: string }>
}

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

function formatMilestone(milestone: string): string {
  if (milestone === 'DAY_1') return 'Day 1'
  if (milestone === 'DAY_3') return 'Day 3'
  if (milestone === 'DAY_7') return 'Day 7'
  return milestone.replaceAll('_', ' ')
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

  const { tenant, stats, questionClusters, recentSessions, firstWeekReviews } = data

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

      <section id="first-week-reviews" className="space-y-4" aria-labelledby="first-week-heading">
        <div className="space-y-1">
          <h2
            id="first-week-heading"
            className="text-2xl font-semibold tracking-tight text-pf-deep"
          >
            First-week learning
          </h2>
          <p className="text-sm leading-6 text-pf-deep/60">
            Privacy-bounded day 1, 3, and 7 evidence. Drafts require human review and cannot send
            from this surface.
          </p>
        </div>
        {firstWeekReviews.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            Reviews appear automatically after a venue release reaches its first-day milestones.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {firstWeekReviews.map((review) => (
              <article
                key={review.id}
                className="min-w-0 rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-pf-deep/50">
                      {formatMilestone(review.milestone)} · {review.venue.name}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-pf-deep">
                      {review.disposition === 'DRAFT_READY'
                        ? 'Check-in draft ready'
                        : 'No follow-up suggested'}
                    </h3>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      review.disposition === 'DRAFT_READY'
                        ? 'bg-amber-100 text-amber-900'
                        : 'bg-emerald-100 text-emerald-900'
                    }`}
                  >
                    {review.disposition === 'DRAFT_READY' ? 'Review draft' : 'Quiet milestone'}
                  </span>
                </div>

                <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {[
                    ['Sessions', review.metrics.publicSessions],
                    ['Questions', review.metrics.guestQuestions],
                    ['Knowledge gaps', review.metrics.knowledgeGapInsights],
                    ['Low confidence', review.metrics.lowConfidenceInsights],
                    ['Negative ratings', review.metrics.negativeFeedback],
                    ['AI failures', review.metrics.failedAiRequests],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-2xl bg-pf-surface p-3">
                      <dt className="text-xs font-medium text-pf-deep/60">{label}</dt>
                      <dd className="mt-1 text-xl font-semibold text-pf-deep">{value}</dd>
                    </div>
                  ))}
                </dl>

                <p className="mt-4 text-xs text-pf-deep/50">
                  Window ended {formatDateTime(review.dueAt)} · estimated AI cost $
                  {review.metrics.estimatedAiCostUsd}
                </p>

                {review.disposition === 'DRAFT_READY' && review.draftSubject && review.draftBody ? (
                  <details className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                    <summary className="cursor-pointer text-sm font-semibold text-amber-950">
                      Review internal draft
                    </summary>
                    <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-amber-900">
                      Draft only — nothing has been sent
                    </p>
                    <p className="mt-3 text-sm font-semibold text-pf-deep">{review.draftSubject}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-pf-deep/80">
                      {review.draftBody}
                    </p>
                    {review.draftReason ? (
                      <p className="mt-3 text-xs leading-5 text-pf-deep/60">{review.draftReason}</p>
                    ) : null}
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Question clusters</h2>
        {questionClusters.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-pf-light bg-pf-white p-8 text-center text-sm text-pf-deep/60 shadow-sm">
            No question clusters found. Run the analytics enrichment job to populate these.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-3xl border border-pf-light bg-pf-white shadow-sm">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Most frequently asked client questions</caption>
              <thead className="border-b border-pf-light text-xs uppercase tracking-wider text-pf-deep/40">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Question
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Type
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Count
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Venue
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Window
                  </th>
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
              <article
                key={session.id}
                className="rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-pf-deep">
                      {formatDateTime(session.startedAt)} · {session.venue.name}
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/60">
                      {session.messageCount} guest messages · {formatVisitor(session.visitorId)}
                    </p>
                  </div>
                  <Link
                    href={`/admin/clients/${tenant.id}/venues/${session.venueId}/chatlogs/${session.id}`}
                    className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-full border border-pf-light px-4 text-sm font-semibold text-pf-primary transition hover:border-pf-accent hover:text-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                  >
                    Review transcript
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
