import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

type Readiness =
  inferRouterOutputs<AppRouter>['admin']['attentionConsole']['founderAbsenceReadiness']

function statusLabel(state: Readiness['dimensions'][number]['state']) {
  return state === 'REVIEW_CANDIDATES' ? 'Review' : 'No visible signal'
}

export function FounderAbsenceReadiness({ data }: { data: Readiness }) {
  return (
    <section
      id="founder-absence-readiness"
      aria-labelledby="founder-absence-heading"
      className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 shadow-sm sm:p-6"
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-indigo-900">
            Founder absence readiness
          </p>
          <h2 id="founder-absence-heading" className="mt-1 text-xl font-semibold text-slate-950">
            Prepare the seven-day maturity test
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            {data.target.explanation}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1">
          <div className="rounded-xl bg-white p-3 ring-1 ring-indigo-100">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Test status
            </dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">Not started</dd>
          </div>
          <div className="rounded-xl bg-white p-3 ring-1 ring-indigo-100">
            <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Current snapshot
            </dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">
              {data.summary.dimensionsWithReviewCandidates} of {data.dimensions.length} areas need
              review
            </dd>
          </div>
        </dl>
      </div>

      <ol className="mt-5 divide-y divide-indigo-100 overflow-hidden rounded-xl border border-indigo-100 bg-white">
        {data.dimensions.map((item) => (
          <li
            key={item.key}
            className="grid gap-2 p-4 md:grid-cols-[11rem_6rem_minmax(0,1fr)] md:items-start"
          >
            <p className="text-sm font-semibold text-slate-950">{item.label}</p>
            <p>
              <span
                className={`inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold ${
                  item.state === 'REVIEW_CANDIDATES'
                    ? 'bg-amber-100 text-amber-950'
                    : 'bg-emerald-100 text-emerald-950'
                }`}
              >
                {statusLabel(item.state)} · {item.visibleSignals}
                {item.hasMore ? '+' : ''}
              </span>
            </p>
            <p className="text-xs leading-5 text-slate-600">{item.interpretation}</p>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs leading-5 text-slate-600">
        Current-state evidence is{' '}
        {data.evidenceWindow.complete ? 'complete for the bounded reads' : 'bounded and incomplete'}
        . This surface cannot change permissions, resolve work, or certify maturity, and it is not a
        launch gate.
      </p>
    </section>
  )
}
