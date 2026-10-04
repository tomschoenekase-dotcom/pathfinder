import type { ReviewStepView } from './types'

function Target({ step }: { step: ReviewStepView }) {
  if (!step.tenantName && !step.venueName) return null
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-700">
      {step.tenantName ? (
        <div className="flex gap-1.5">
          <dt className="text-slate-600">Client</dt>
          <dd className="font-semibold text-slate-950">{step.tenantName}</dd>
        </div>
      ) : null}
      {step.venueName ? (
        <div className="flex gap-1.5">
          <dt className="text-slate-600">Venue</dt>
          <dd className="font-semibold text-slate-950">{step.venueName}</dd>
        </div>
      ) : null}
    </dl>
  )
}

const CHANGE_HEADING = {
  applied: 'Changed (before, then after)',
  restore: 'Will be restored (now, then restored)',
  pending: 'Will change (now, then proposed)',
} as const

/** The full change for a proposal or each step of a plan. Presentational; no client state. */
export function OperatorReviewSteps({
  steps,
  pending,
}: {
  steps: readonly ReviewStepView[]
  pending: boolean
}) {
  return (
    <ol className="space-y-3">
      {steps.map((step) => (
        <li key={step.proposalId} className="rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-base font-semibold text-slate-950">
            {steps.length > 1 ? `${step.index + 1}. ` : ''}
            {step.title}
          </p>
          <Target step={step} />
          {step.lines.length ? (
            <ul className="mt-2 divide-y divide-slate-200 border-y border-slate-200 text-sm text-slate-800">
              {step.lines.map((line) => (
                <li key={line} className="break-words py-1.5">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          {step.changeMode && step.changes.length ? (
            <div className="mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                {CHANGE_HEADING[step.changeMode]}
              </p>
              <dl className="mt-1 divide-y divide-slate-200 border-y border-slate-200 text-sm">
                {step.changes.map((change) => (
                  <div key={change.field} className="grid grid-cols-[7rem_1fr] gap-2 py-1.5">
                    <dt className="break-words text-slate-600">{change.field}</dt>
                    <dd className="min-w-0 break-words">
                      <span className="text-slate-700">{change.before}</span>{' '}
                      <span aria-hidden="true">→</span>
                      <span className="sr-only"> becomes </span>{' '}
                      <span className="font-semibold text-slate-950">{change.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {step.failureCode ? (
            <p className="mt-2 text-sm font-semibold text-red-800">
              Did not apply: {step.failureCode}
            </p>
          ) : null}
          {pending && step.changeMode === null ? (
            <p className="mt-2 text-xs text-slate-600">
              The target is checked again when you approve. If it changed, this request goes stale
              and nothing is applied.
            </p>
          ) : null}
          <details className="mt-2">
            <summary className="min-h-8 cursor-pointer text-xs font-medium text-slate-700">
              Exact arguments
            </summary>
            <pre
              tabIndex={0}
              aria-label="Exact arguments text"
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-2 text-xs text-slate-800"
            >
              {step.args}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  )
}
