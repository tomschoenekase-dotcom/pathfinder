import { DecisionButtons } from './DecisionButtons'
import { formatWhen, untilLabel } from './format'
import { OperatorReviewSteps } from './OperatorReviewSteps'
import type { OperatorReviewItemView } from './types'

/** Pending proposals and plans with the full change. Server-rendered; only the buttons are client. */
export function OperatorInbox({
  items,
  now,
}: {
  items: readonly OperatorReviewItemView[]
  now: Date
}) {
  if (items.length === 0) {
    return (
      <section
        aria-labelledby="inbox-empty"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <h2 id="inbox-empty" className="text-lg font-semibold text-slate-950">
          Nothing is waiting for you
        </h2>
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          When the Dot proposes a change that needs your approval, it appears here with the full
          change and also arrives as a one-tap link. Capabilities set to act without asking never
          show up here; check the Audit tab for those.
        </p>
      </section>
    )
  }
  return (
    <ul className="space-y-5">
      {items.map((item) => (
        <li key={item.id}>
          <article
            aria-labelledby={`inbox-${item.id}`}
            className="rounded-2xl border border-slate-300 bg-slate-50 p-4 sm:p-5"
          >
            <header>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                {item.type === 'plan' ? `Plan, ${item.steps.length} steps` : 'Single change'} from{' '}
                {item.clientName}
              </p>
              <h2 id={`inbox-${item.id}`} className="mt-1 text-lg font-semibold text-slate-950">
                {item.title}
              </h2>
              <p className="mt-0.5 text-sm text-slate-700">
                Proposed {formatWhen(item.createdAt)}, {untilLabel(item.expiresAt, now)}
              </p>
            </header>
            <div className="mt-3">
              <OperatorReviewSteps steps={item.steps} pending />
            </div>
            <div className="mt-4">
              <DecisionButtons
                id={item.id}
                argsHash={item.argsHash}
                size="compact"
                label={item.title}
              />
            </div>
          </article>
        </li>
      ))}
    </ul>
  )
}
