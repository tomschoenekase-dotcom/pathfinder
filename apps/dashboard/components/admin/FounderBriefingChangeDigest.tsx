import Link from 'next/link'

type Change = {
  kind: 'CRITICAL_RISK' | 'DECISION' | 'CUSTOMER' | 'OUTCOME' | 'COMPLETED_WORK'
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL'
  title: string
  detail: string
  occurredAt: Date | string
  action: { label: string; href: string }
  source: { objectId: string }
}

type Props = {
  digest: {
    limit: number
    visibleCount: number
    mayHaveMore: boolean
    items: Change[]
  }
}

const labels: Record<Change['kind'], string> = {
  CRITICAL_RISK: 'Critical risk',
  DECISION: 'Decision',
  CUSTOMER: 'Customer',
  OUTCOME: 'Outcome',
  COMPLETED_WORK: 'Completed',
}

function tone(urgency: Change['urgency']) {
  if (urgency === 'CRITICAL') return 'border-rose-300/50 bg-rose-400/10 text-rose-100'
  if (urgency === 'HIGH') return 'border-amber-300/50 bg-amber-400/10 text-amber-100'
  return 'border-slate-700 bg-slate-950 text-slate-100'
}

export function FounderBriefingChangeDigest({ digest }: Props) {
  return (
    <section className="mt-4" aria-labelledby="founder-change-digest-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="founder-change-digest-heading" className="text-sm font-semibold text-white">
          What changed
        </h3>
        <p className="text-xs text-slate-400">
          {digest.visibleCount} visible in this bounded snapshot
        </p>
      </div>
      {digest.items.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-700 p-4 text-sm text-slate-400">
          No new activity is visible since your recorded review cursor.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 lg:grid-cols-2">
          {digest.items.map((item) => (
            <li
              key={`${item.kind}:${item.source.objectId}`}
              className={`rounded-xl border p-4 ${tone(item.urgency)}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide">
                <span>{labels[item.kind]}</span>
                <span aria-hidden="true">·</span>
                <span className="font-medium normal-case tracking-normal text-slate-400">
                  {new Date(item.occurredAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 font-semibold leading-6 text-white">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-300">{item.detail}</p>
              <Link
                href={item.action.href}
                className="mt-3 inline-flex min-h-10 items-center text-sm font-semibold text-sky-300"
              >
                {item.action.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {digest.mayHaveMore ? (
        <p className="mt-3 text-xs leading-5 text-slate-400">
          Showing up to {digest.limit} priority changes. Review the full queues below for additional
          or older activity.
        </p>
      ) : null}
    </section>
  )
}
