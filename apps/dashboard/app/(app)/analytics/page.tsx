import Link from 'next/link'

import { appRouter, createTRPCContext } from '@pathfinder/api'

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

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/analytics'),
  })

  return appRouter.createCaller(ctx)
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
      <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-sm text-slate-600">
        Insufficient conversation volume this week to produce a meaningful digest yet.
      </div>
    )
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {insights.map((insight, index) => (
        <article
          key={`${insight.title}-${index}`}
          className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5"
        >
          <span
            className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${insightStyles[insight.type]}`}
          >
            {insight.type}
          </span>
          <h3 className="mt-4 text-lg font-semibold text-slate-950">{insight.title}</h3>
          <p className="mt-3 text-sm leading-6 text-slate-600">{insight.body}</p>
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
      <div className="rounded-[1.75rem] border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
        <p className="text-lg font-semibold text-slate-950">
          Analytics data will appear once guests start using PathFinder.
        </p>
      </div>
    )
  }

  const values = series.map((point) => point.value)
  const max = Math.max(...values, 1)
  const total = values.reduce((sum, value) => sum + value, 0)
  const points = buildPolylinePoints(values)

  return (
    <div className="space-y-6 rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
            Tier 1 Metrics
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Sessions per day
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pre-aggregated daily session counts from DailyRollup.
          </p>
        </div>
        <div className="rounded-[1.25rem] bg-slate-950 px-4 py-3 text-white">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-300">30 day total</p>
          <p className="mt-2 text-2xl font-semibold">{total}</p>
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50 p-4">
        <div className="h-56">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
            <line x1="0" y1="100" x2="100" y2="100" stroke="#cbd5e1" strokeWidth="1" />
            <polyline
              fill="none"
              stroke="#0891b2"
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
                  fill="#0f172a"
                />
              )
            })}
          </svg>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-500 sm:grid-cols-5 xl:grid-cols-10">
          {series.map((point) => (
            <div key={point.date} className="rounded-xl bg-white px-3 py-2">
              <p className="font-medium text-slate-700">{point.label}</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">{point.value}</p>
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
    <section className="space-y-4 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
          Conversation Themes
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          Top questions this week
        </h2>
      </div>

      {questions.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-sm text-slate-600">
          No guest questions recorded yet.
        </div>
      ) : (
        <ol className="space-y-3">
          {questions.map((item, index) => (
            <li
              key={`${item.question}-${index}`}
              className="flex items-start justify-between gap-4 rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-4"
            >
              <div className="flex min-w-0 items-start gap-4">
                <span className="mt-0.5 text-sm font-semibold text-cyan-700">{index + 1}.</span>
                <p className="text-sm leading-6 text-slate-700">{item.question}</p>
              </div>
              <span className="inline-flex shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                {item.count}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const caller = await createCaller()
  const resolvedSearchParams = searchParams ? await searchParams : undefined

  const [latestDigest, digests, dailyStats, topQuestions] = await Promise.all([
    caller.analytics.getLatestDigest(),
    caller.analytics.listDigests(),
    caller.analytics.getDailyStats({ days: 30 }),
    caller.analytics.getTopQuestions({ days: 7 }),
  ])

  const selectedDigestId = resolvedSearchParams?.digest
  const selectedDigest =
    selectedDigestId && (!latestDigest || latestDigest.id !== selectedDigestId)
      ? await caller.analytics.getDigest({ id: selectedDigestId })
      : latestDigest

  const latestDigestSummary = digests[0] ?? null
  const isProcessingCurrentDigest =
    latestDigest === null && latestDigestSummary?.status === 'PROCESSING'

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">
            Analytics
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight">
            Guest behavior and weekly insight digests
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            Review AI-generated weekly takeaways and the supporting daily session trend line without
            querying live conversation tables.
          </p>
        </section>

        <section className="space-y-6 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
                Weekly Digest
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                Latest manager summary
              </h2>
            </div>
            {selectedDigest ? (
              <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center">
                <div className="rounded-[1.25rem] bg-slate-100 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sessions</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {selectedDigest.sessionCount}
                  </p>
                </div>
                <div className="rounded-[1.25rem] bg-slate-100 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Messages</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {selectedDigest.messageCount}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {selectedDigest ? (
            <div className="space-y-5">
              <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 px-5 py-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-lg font-semibold text-slate-950">
                      {formatWeekRange(selectedDigest.weekStart, selectedDigest.weekEnd)}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      Generated{' '}
                      {selectedDigest.generatedAt
                        ? selectedDigest.generatedAt.toLocaleString()
                        : 'when processing completes'}
                    </p>
                  </div>
                  <span className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                    {formatDigestStatus(selectedDigest.status)}
                  </span>
                </div>
              </div>

              <InsightCards insights={selectedDigest.insights as DigestInsight[]} />
            </div>
          ) : isProcessingCurrentDigest ? (
            <div className="rounded-[1.75rem] border border-cyan-200 bg-cyan-50 px-6 py-10 text-center">
              <p className="text-lg font-semibold text-slate-950">
                This week&apos;s digest is being generated...
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                The worker has queued the current summary and it will appear here once processing
                completes.
              </p>
            </div>
          ) : (
            <div className="rounded-[1.75rem] border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
              <p className="text-lg font-semibold text-slate-950">
                Your first weekly digest will appear here after Sunday night.
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Once enough guest conversations accumulate, PathFinder will generate a
                manager-friendly digest automatically.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
          <details className="group" open={Boolean(digests.length)}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
                  History
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  Past digests
                </h2>
              </div>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                {digests.length} available
              </span>
            </summary>

            <div className="mt-6 space-y-3">
              {digests.length === 0 ? (
                <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-sm text-slate-600">
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
                      className="rounded-[1.5rem] border border-slate-200 bg-slate-50"
                    >
                      <Link
                        href={`/analytics?digest=${digest.id}`}
                        className="flex flex-col gap-3 px-5 py-4 transition hover:bg-white sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p className="text-base font-semibold text-slate-950">
                            {formatWeekRange(digest.weekStart, digest.weekEnd)}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {digest.sessionCount} sessions · {digest.messageCount} messages
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                            {formatDigestStatus(digest.status)}
                          </span>
                          {isSelected ? (
                            <span className="rounded-full bg-cyan-500 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                              Viewing
                            </span>
                          ) : null}
                        </div>
                      </Link>

                      {isSelected && selectedDigest && selectedDigest.id === digest.id ? (
                        <div className="border-t border-slate-200 px-5 py-5">
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
        <TopQuestionsList questions={topQuestions} />
      </div>
    </main>
  )
}
