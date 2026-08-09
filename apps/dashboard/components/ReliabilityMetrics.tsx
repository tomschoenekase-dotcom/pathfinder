type ReliabilityRow = {
  venueId: string
  date: Date
  metric: string
  value: number
}

type ReliabilityVenue = {
  id: string
  name: string
}

const RELIABILITY_STAGES = [
  { key: 'embedding', label: 'Embedding' },
  { key: 'retrieval', label: 'Retrieval' },
  { key: 'prompt_assembly', label: 'Prompt assembly' },
  { key: 'model', label: 'Model generation' },
  { key: 'persistence', label: 'Persistence' },
  { key: 'total', label: 'Completed response' },
] as const

function finiteNonnegative(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function formatDuration(value: number | null): string {
  return value === null ? 'Not available' : `${value.toLocaleString('en-US')} ms`
}

function formatRate(basisPoints: number | null): string {
  if (basisPoints === null) return 'Not available'
  return `${(basisPoints / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

export function ReliabilityMetrics({
  rows,
  venues,
}: {
  rows: ReliabilityRow[]
  venues: ReliabilityVenue[]
}) {
  const venueIds = new Set(venues.map((venue) => venue.id))
  const latestActiveDate = new Map<string, string>()

  for (const row of rows) {
    if (!venueIds.has(row.venueId) || row.metric !== 'chat_responses' || row.value <= 0) continue
    const date = row.date.toISOString().slice(0, 10)
    if (date > (latestActiveDate.get(row.venueId) ?? '')) {
      latestActiveDate.set(row.venueId, date)
    }
  }

  return (
    <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Reliability
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
          Guest chat latency by venue
        </h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Latest day with completed responses in the last 30 days. These completed-request timings
          do not measure time to first token.
        </p>
      </div>

      {venues.length === 0 ? (
        <div className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface px-5 py-6 text-sm text-pf-deep/60">
          Reliability metrics will appear after an active venue is available.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {venues.map((venue) => {
            const date = latestActiveDate.get(venue.id)
            const values = new Map(
              rows
                .filter(
                  (row) => row.venueId === venue.id && row.date.toISOString().slice(0, 10) === date,
                )
                .map((row) => [row.metric, row.value]),
            )

            if (!date) {
              return (
                <article
                  key={venue.id}
                  className="rounded-[1.5rem] border border-dashed border-pf-light bg-pf-surface p-5"
                >
                  <h3 className="font-semibold text-pf-deep">{venue.name}</h3>
                  <p className="mt-2 text-sm text-pf-deep/60">
                    No completed chat responses were recorded in this window.
                  </p>
                </article>
              )
            }

            const responses = finiteNonnegative(values.get('chat_responses')) ?? 0
            const fallbackRate = finiteNonnegative(values.get('chat_fallback_rate_bps'))

            return (
              <article
                key={venue.id}
                className="overflow-hidden rounded-[1.5rem] border border-pf-light"
              >
                <div className="flex flex-col gap-2 bg-pf-surface px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-pf-deep">{venue.name}</h3>
                    <p className="mt-1 text-xs text-pf-deep/50">
                      {new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </p>
                  </div>
                  <p className="text-xs text-pf-deep/60">
                    {`${responses.toLocaleString('en-US')} responses · ${formatRate(fallbackRate)} fallback`}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <caption className="sr-only">
                      {venue.name} guest chat reliability percentiles for {date}
                    </caption>
                    <thead className="text-left text-xs uppercase tracking-wider text-pf-deep/50">
                      <tr>
                        <th className="px-5 py-3 font-medium">Stage</th>
                        <th className="px-5 py-3 text-right font-medium">p50</th>
                        <th className="px-5 py-3 text-right font-medium">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {RELIABILITY_STAGES.map((stage) => (
                        <tr key={stage.key} className="border-t border-pf-light">
                          <th className="px-5 py-3 text-left font-medium text-pf-deep">
                            {stage.label}
                          </th>
                          <td className="px-5 py-3 text-right text-pf-deep/70">
                            {formatDuration(
                              finiteNonnegative(values.get(`chat_${stage.key}_p50_ms`)),
                            )}
                          </td>
                          <td className="px-5 py-3 text-right font-semibold text-pf-deep">
                            {formatDuration(
                              finiteNonnegative(values.get(`chat_${stage.key}_p95_ms`)),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <p className="text-xs leading-5 text-pf-deep/50">
        Reliability events are privacy-bounded and best-effort, so an analytics outage can
        undercount responses. Missing percentiles are shown as unavailable, never as zero.
      </p>
    </section>
  )
}
