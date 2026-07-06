import { createDashboardCaller } from '../../../lib/server-caller'

function aggregateSessionSeries(
  rows: Array<{
    date: Date
    metric: string
    value: number
  }>,
) {
  const sessionsByDay = new Map<string, number>()

  for (const row of rows) {
    if (row.metric !== 'sessions') continue
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
  if (values.length === 0) return ''
  const max = Math.max(...values, 1)

  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100
      const y = 100 - (value / max) * 100
      return `${x},${y}`
    })
    .join(' ')
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
  const total = values.reduce((sum, value) => sum + value, 0)
  const points = buildPolylinePoints(values)

  return (
    <section className="space-y-6 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
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
          </svg>
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
    </section>
  )
}

function VisitorStatsCards({ stats }: { stats: { totalMessages: number; totalSessions: number } }) {
  const cards = [
    { label: 'Total sessions', value: stats.totalSessions, hint: 'Chat visits (30 days)' },
    { label: 'Total messages', value: stats.totalMessages, hint: 'Messages sent by guests' },
  ]

  return (
    <section className="grid gap-4 sm:grid-cols-2">
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

function WeeklyThemes({
  themes,
  weekStart,
  weekEnd,
}: {
  themes: Array<{ title: string; explanation: string }>
  weekStart: Date | null
  weekEnd: Date | null
}) {
  const rangeLabel =
    weekStart && weekEnd
      ? `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : null

  return (
    <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Weekly Themes
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Top 3 things guests asked about this week
        </h2>
        {rangeLabel ? <p className="mt-1 text-xs text-pf-deep/50">Week of {rangeLabel}</p> : null}
      </div>
      {themes.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          Themes appear once guests have asked enough questions this week for a pattern to emerge.
        </div>
      ) : (
        <ol className="space-y-3">
          {themes.map((theme, index) => (
            <li
              key={`${theme.title}-${index}`}
              className="rounded-[1.5rem] border border-pf-light bg-pf-surface px-5 py-4"
            >
              <p className="text-sm font-semibold text-pf-deep">
                <span className="mr-2 font-semibold text-pf-accent">{index + 1}.</span>
                {theme.title}
              </p>
              <p className="mt-2 text-sm leading-6 text-pf-deep/70">{theme.explanation}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function RankedList({
  title,
  eyebrow,
  empty,
  items,
}: {
  title: string
  eyebrow: string
  empty: string
  items: Array<{ label: string; count: number; meta?: string }>
}) {
  return (
    <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">{title}</h2>
      </div>
      {items.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          {empty}
        </div>
      ) : (
        <ol className="space-y-3">
          {items.map((item, index) => (
            <li
              key={`${item.label}-${index}`}
              className="flex items-start justify-between gap-4 rounded-[1.5rem] border border-pf-light bg-pf-surface px-5 py-4"
            >
              <div className="min-w-0">
                <p className="text-sm leading-6 text-pf-deep">
                  <span className="mr-2 font-semibold text-pf-accent">{index + 1}.</span>
                  {item.label}
                </p>
                {item.meta ? <p className="mt-1 text-xs text-pf-deep/50">{item.meta}</p> : null}
              </div>
              <span className="inline-flex shrink-0 rounded-full bg-pf-white px-3 py-1 text-xs font-semibold text-pf-deep">
                {item.count}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export default async function AnalyticsPage() {
  const caller = await createDashboardCaller('/analytics')

  const [dailyStats, visitorStats, weeklyThemes, venues] = await Promise.all([
    caller.analytics.getDailyStats({ days: 30 }),
    caller.analytics.getVisitorStats({ days: 30 }),
    caller.analytics.getWeeklyThemes(),
    caller.venue.list(),
  ])

  const placeInterestByVenue = await Promise.all(
    venues.map(async (venue) => ({
      venue,
      places: await caller.analytics.getPlaceInterest({ venueId: venue.id, days: 30 }),
    })),
  )
  const placeInterestItems = placeInterestByVenue.flatMap((group) =>
    group.places.slice(0, 10).map((place) => ({
      label: place.name,
      count: place.score,
      meta: `${group.venue.name}: ${place.views} views, ${place.clicks} clicks, ${place.directions} directions`,
    })),
  )

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">
            Guest behavior and conversation analytics
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-pf-deep/60">
            Review guest activity and place interest.
          </p>
        </section>

        <VisitorStatsCards stats={visitorStats} />

        <SessionTrendChart rows={dailyStats} />

        <WeeklyThemes
          themes={weeklyThemes.themes}
          weekStart={weeklyThemes.weekStart}
          weekEnd={weeklyThemes.weekEnd}
        />

        <RankedList
          eyebrow="Place Interest"
          title="Which spots guests care about"
          empty="Place interest appears once guests start exploring your points of interest."
          items={placeInterestItems}
        />
      </div>
    </main>
  )
}
