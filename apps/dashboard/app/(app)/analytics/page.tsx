import Link from 'next/link'

import { createDashboardCaller } from '../../../lib/server-caller'

type AnalyticsPageProps = {
  searchParams?: Promise<{
    digest?: string
  }>
}

type DigestInsight = {
  type: 'trend' | 'confusion' | 'interest' | 'recommendation'
  title: string
  body: string
}

const insightStyles: Record<DigestInsight['type'], string> = {
  trend: 'border-sky-200 bg-sky-50 text-sky-700',
  confusion: 'border-rose-200 bg-rose-50 text-rose-700',
  interest: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  recommendation: 'border-amber-200 bg-amber-50 text-amber-700',
}

function formatWeekRange(weekStart: Date, weekEnd: Date): string {
  return `Week of ${weekStart.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} - ${weekEnd.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`
}

function formatDigestStatus(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

function aggregateSessionSeries(
  rows: Array<{
    date: Date
    metric: string
    value: number
  }>,
) {
  const sessionsByDay = new Map<string, number>()

  for (const row of rows) {
    if (row.metric !== 'sessions') {
      continue
    }

    const key = row.date.toISOString().slice(0, 10)
    sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + row.value)
  }

  return Array.from(sessionsByDay.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      label: new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
      value,
    }))
}

function buildPolylinePoints(values: number[]) {
  if (values.length === 0) {
    return ''
  }

  const max = Math.max(...values, 1)

  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100
      const y = 100 - (value / max) * 100

      return `${x},${y}`
    })
    .join(' ')
}

function InsightCards({ insights }: { insights: DigestInsight[] }) {
  if (insights.length === 0) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
        Insufficient conversation volume this week to produce a meaningful digest yet.
      </div>
    )
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {insights.map((insight, index) => (
        <article
          key={`${insight.title}-${index}`}
          className="rounded-[1.5rem] border border-pf-light bg-pf-white p-5 shadow-sm"
        >
          <span
            className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${insightStyles[insight.type]}`}
          >
            {insight.type}
          </span>
          <h3 className="mt-4 text-lg font-semibold text-pf-deep">{insight.title}</h3>
          <p className="mt-3 text-sm leading-6 text-pf-deep/60">{insight.body}</p>
        </article>
      ))}
    </div>
  )
}

function SessionTrendChart({
  rows,
}: {
  rows: Array<{
    date: Date
    metric: string
    value: number
  }>
}) {
  const series = aggregateSessionSeries(rows)

  if (series.length === 0) {
    return (
      <div className="rounded-[1.75rem] border border-dashed border-pf-light bg-pf-surface px-6 py-10 text-center">
        <p className="text-lg font-semibold text-pf-deep">
          Analytics data will appear once guests start using PathFinder.
        </p>
      </div>
    )
  }

  const values = series.map((point) => point.value)
  const max = Math.max(...values, 1)
  const total = values.reduce((sum, value) => sum + value, 0)
  const points = buildPolylinePoints(values)
  const yLabels = [
    { value: max, pct: 0 },
    { value: Math.round(max / 2), pct: 50 },
    { value: 0, pct: 100 },
  ]

  return (
    <div className="space-y-6 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            Tier 1 Metrics
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
            Sessions per day
          </h2>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Daily guest chat sessions over the last 30 days.
          </p>
        </div>
        <div className="rounded-2xl bg-pf-primary px-4 py-3 text-white">
          <p className="text-xs uppercase tracking-[0.2em] text-pf-light/60">30 day total</p>
          <p className="mt-2 text-2xl font-semibold">{total}</p>
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-pf-light bg-pf-surface p-4">
        <div className="relative h-56">
          <div className="absolute inset-y-0 left-0 w-8">
            {yLabels.map(({ value, pct }) => (
              <span
                key={pct}
                className="absolute right-0 text-[10px] leading-none text-pf-deep/40"
                style={{ top: `${pct}%`, transform: 'translateY(-50%)' }}
              >
                {value}
              </span>
            ))}
          </div>
          <div className="absolute inset-y-0 left-8 right-0">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
              <line x1="0" y1="0" x2="100" y2="0" stroke="#C9D4E3" strokeWidth="0.5" />
              <line x1="0" y1="50" x2="100" y2="50" stroke="#C9D4E3" strokeWidth="0.5" />
              <line x1="0" y1="100" x2="100" y2="100" stroke="#C9D4E3" strokeWidth="1" />
              <polyline
                fill="none"
                stroke="#3A7BD5"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />
              {values.map((value, index) => {
                const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100
                const y = 100 - (value / max) * 100

                return (
                  <circle
                    key={`${series[index]?.date ?? index}`}
                    cx={x}
                    cy={y}
                    r="2.2"
                    fill="#1F4E8C"
                  />
                )
              })}
            </svg>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-pf-deep/50 sm:grid-cols-5 xl:grid-cols-10">
          {series.map((point) => (
            <div key={point.date} className="rounded-xl bg-pf-white px-3 py-2">
              <p className="font-medium text-pf-deep">{point.label}</p>
              <p className="mt-1 text-sm font-semibold text-pf-deep">{point.value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TopQuestionsList({
  questions,
}: {
  questions: Array<{
    question: string
    count: number
  }>
}) {
  return (
    <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Conversation Themes
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Guest Questions (Last 7 Days)
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Showing most-asked questions in the last 7 days.
        </p>
      </div>

      {questions.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          No guest questions recorded yet.
        </div>
      ) : (
        <ol className="space-y-3">
          {questions.map((item, index) => (
            <li
              key={`${item.question}-${index}`}
              className="flex items-start justify-between gap-4 rounded-[1.5rem] border border-pf-light bg-pf-surface px-5 py-4"
            >
              <div className="flex min-w-0 items-start gap-4">
                <span className="mt-0.5 text-sm font-semibold text-pf-accent">{index + 1}.</span>
                <p className="text-sm leading-6 text-pf-deep">{item.question}</p>
              </div>
              <span className="inline-flex shrink-0 rounded-full bg-pf-white px-3 py-1 text-xs font-semibold text-pf-deep">
                {item.count}x
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function VisitorStatsCards({
  stats,
}: {
  stats: { uniqueVisitors: number; totalMessages: number; totalSessions: number }
}) {
  const cards = [
    { label: 'Unique visitors', value: stats.uniqueVisitors, hint: 'Distinct devices (30 days)' },
    {
      label: 'Total messages',
      value: stats.totalMessages,
      hint: 'Messages sent by guests (30 days)',
    },
    { label: 'Total sessions', value: stats.totalSessions, hint: 'Chat visits (30 days)' },
  ]

  return (
    <section className="grid gap-4 sm:grid-cols-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            {card.label}
          </p>
          <p className="mt-3 text-3xl font-semibold text-pf-deep">{card.value}</p>
          <p className="mt-1 text-xs text-pf-deep/50">{card.hint}</p>
        </div>
      ))}
    </section>
  )
}

function ContentGapsList({
  gaps,
}: {
  gaps: Array<{ question: string; count: number; examples: string[] }>
}) {
  return (
    <section className="space-y-4 rounded-3xl border border-amber-200 bg-amber-50/40 p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-600">
          Content Gaps
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Questions your guide couldn&apos;t confidently answer
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Add or improve venue content for these and your guide will start answering them well.
        </p>
      </div>

      {gaps.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-amber-200 bg-pf-white px-5 py-6 text-sm text-pf-deep/60">
          No content gaps detected yet. Gaps appear after the nightly analysis runs on real guest
          questions.
        </div>
      ) : (
        <ol className="space-y-3">
          {gaps.map((gap, index) => (
            <li
              key={`${gap.question}-${index}`}
              className="rounded-[1.5rem] border border-amber-200 bg-pf-white px-5 py-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-4">
                  <span className="mt-0.5 text-sm font-semibold text-amber-600">{index + 1}.</span>
                  <p className="text-sm font-medium leading-6 text-pf-deep">{gap.question}</p>
                </div>
                <span className="inline-flex shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                  {gap.count}x
                </span>
              </div>
              {gap.examples.length > 1 ? (
                <p className="mt-2 pl-8 text-xs text-pf-deep/50">
                  Also asked as: {gap.examples.slice(1, 3).join(' · ')}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function TopTopicsList({
  topics,
}: {
  topics: Array<{ topic: string; label: string; count: number }>
}) {
  const max = Math.max(...topics.map((topic) => topic.count), 1)

  return (
    <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">Topics</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          What guests ask about
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Questions grouped into topics over the last 30 days.
        </p>
      </div>

      {topics.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          Topic breakdown appears once the nightly analysis has classified some questions.
        </div>
      ) : (
        <ul className="space-y-3">
          {topics.map((topic) => (
            <li key={topic.topic} className="flex items-center gap-4">
              <span className="w-40 shrink-0 text-sm font-medium text-pf-deep">{topic.label}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-pf-surface">
                <div
                  className="h-full rounded-full bg-pf-accent"
                  style={{ width: `${Math.max(4, (topic.count / max) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-sm font-semibold text-pf-deep">
                {topic.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PlaceInterestList({
  groups,
}: {
  groups: Array<{
    venue: { id: string; name: string }
    places: Array<{
      placeId: string
      name: string
      score: number
      mentions: number
      views: number
      clicks: number
      directions: number
    }>
  }>
}) {
  const groupsWithData = groups.filter((group) => group.places.length > 0)

  return (
    <section className="space-y-5 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Place Interest
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Which spots guests care about
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          A weighted blend of mentions, card views, clicks, and directions opened (last 30 days).
        </p>
      </div>

      {groupsWithData.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          Place interest appears once guests start exploring your points of interest.
        </div>
      ) : (
        <div className="space-y-6">
          {groupsWithData.map((group) => (
            <div key={group.venue.id} className="space-y-3">
              {groups.length > 1 ? (
                <p className="text-sm font-semibold text-pf-deep/70">{group.venue.name}</p>
              ) : null}
              <ol className="space-y-2">
                {group.places.slice(0, 10).map((place, index) => (
                  <li
                    key={place.placeId}
                    className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-pf-light bg-pf-surface px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="text-sm font-semibold text-pf-accent">{index + 1}.</span>
                      <span className="truncate text-sm font-medium text-pf-deep">
                        {place.name}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-xs text-pf-deep/50">
                      <span>{place.views} views</span>
                      <span>{place.clicks} clicks</span>
                      <span>{place.directions} directions</span>
                      <span className="rounded-full bg-pf-white px-3 py-1 text-sm font-semibold text-pf-deep">
                        {place.score}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const caller = await createDashboardCaller('/analytics')
  const resolvedSearchParams = searchParams ? await searchParams : undefined

  const [
    latestDigest,
    digests,
    dailyStats,
    topQuestions,
    visitorStats,
    topTopics,
    contentGaps,
    venues,
  ] = await Promise.all([
    caller.analytics.getLatestDigest(),
    caller.analytics.listDigests(),
    caller.analytics.getDailyStats({ days: 30 }),
    caller.analytics.getTopQuestions({}),
    caller.analytics.getVisitorStats({ days: 30 }),
    caller.analytics.getTopTopics({ days: 30 }),
    caller.analytics.getContentGaps({ days: 30 }),
    caller.venue.list(),
  ])

  const placeInterestByVenue = await Promise.all(
    venues.map(async (venue) => ({
      venue,
      places: await caller.analytics.getPlaceInterest({ venueId: venue.id, days: 30 }),
    })),
  )

  const selectedDigestId = resolvedSearchParams?.digest
  const selectedDigest =
    selectedDigestId && (!latestDigest || latestDigest.id !== selectedDigestId)
      ? await caller.analytics.getDigest({ id: selectedDigestId })
      : latestDigest

  const latestDigestSummary = digests[0] ?? null
  const isProcessingCurrentDigest =
    latestDigest === null && latestDigestSummary?.status === 'PROCESSING'

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">
            Guest behavior and weekly insight digests
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-deep/60">
            Review AI-generated weekly takeaways and the supporting daily session trend line without
            querying live conversation tables.
          </p>
        </section>

        <VisitorStatsCards stats={visitorStats} />

        <ContentGapsList gaps={contentGaps} />

        <section className="space-y-6 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
                Weekly Digest
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep">
                Latest manager summary
              </h2>
            </div>
            {selectedDigest ? (
              <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center">
                <div className="rounded-[1.25rem] bg-pf-surface px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/50">Sessions</p>
                  <p className="mt-2 text-2xl font-semibold text-pf-deep">
                    {selectedDigest.sessionCount}
                  </p>
                </div>
                <div className="rounded-[1.25rem] bg-pf-surface px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-pf-deep/50">Messages</p>
                  <p className="mt-2 text-2xl font-semibold text-pf-deep">
                    {selectedDigest.messageCount}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {selectedDigest ? (
            <div className="space-y-5">
              <div className="rounded-[1.5rem] border border-pf-light bg-pf-surface px-5 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-lg font-semibold text-pf-deep">
                      {formatWeekRange(selectedDigest.weekStart, selectedDigest.weekEnd)}
                    </p>
                    <p className="mt-1 text-sm text-pf-deep/60">
                      Generated{' '}
                      {selectedDigest.generatedAt
                        ? selectedDigest.generatedAt.toLocaleString()
                        : 'when processing completes'}
                    </p>
                  </div>
                  <span className="inline-flex rounded-full border border-pf-light bg-pf-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-pf-deep/60">
                    {formatDigestStatus(selectedDigest.status)}
                  </span>
                </div>
              </div>

              <InsightCards insights={selectedDigest.insights as DigestInsight[]} />
            </div>
          ) : isProcessingCurrentDigest ? (
            <div className="rounded-[1.75rem] border border-pf-light bg-pf-surface px-6 py-10 text-center">
              <p className="text-lg font-semibold text-pf-deep">
                This week&apos;s digest is being generated...
              </p>
              <p className="mt-2 text-sm leading-6 text-pf-deep/60">
                The worker has queued the current summary and it will appear here once processing
                completes.
              </p>
            </div>
          ) : (
            <div className="rounded-[1.75rem] border border-dashed border-pf-light bg-pf-surface px-6 py-10 text-center">
              <p className="text-lg font-semibold text-pf-deep">
                Your first weekly digest will appear here after Sunday night.
              </p>
              <p className="mt-2 text-sm leading-6 text-pf-deep/60">
                Once enough guest conversations accumulate, PathFinder will generate a
                manager-friendly digest automatically.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <details className="group" open={Boolean(digests.length)}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
                  History
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
                  Past digests
                </h2>
              </div>
              <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-medium text-pf-deep/60">
                {digests.length} available
              </span>
            </summary>

            <div className="mt-6 space-y-3">
              {digests.length === 0 ? (
                <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
                  No weekly digests have been generated yet.
                </div>
              ) : (
                digests.map((digest: (typeof digests)[number]) => {
                  const isSelected =
                    selectedDigestId === digest.id ||
                    (!selectedDigestId && latestDigest?.id === digest.id)

                  return (
                    <div
                      key={digest.id}
                      className="rounded-[1.5rem] border border-pf-light bg-pf-surface"
                    >
                      <Link
                        href={`/analytics?digest=${digest.id}`}
                        className="flex flex-col gap-3 px-5 py-4 transition hover:bg-white sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p className="text-base font-semibold text-pf-deep">
                            {formatWeekRange(digest.weekStart, digest.weekEnd)}
                          </p>
                          <p className="mt-1 text-sm text-pf-deep/60">
                            {digest.sessionCount} sessions · {digest.messageCount} messages
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="rounded-full border border-pf-light bg-pf-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-pf-deep/60">
                            {formatDigestStatus(digest.status)}
                          </span>
                          {isSelected ? (
                            <span className="rounded-full bg-pf-accent px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                              Viewing
                            </span>
                          ) : null}
                        </div>
                      </Link>

                      {isSelected && selectedDigest && selectedDigest.id === digest.id ? (
                        <div className="border-t border-pf-light px-5 py-5">
                          <InsightCards insights={selectedDigest.insights as DigestInsight[]} />
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </details>
        </section>

        <SessionTrendChart rows={dailyStats} />
        <TopTopicsList topics={topTopics} />
        <TopQuestionsList questions={topQuestions} />
        <PlaceInterestList groups={placeInterestByVenue} />
      </div>
    </main>
  )
}
