type DecisionContext = {
  attentionReason: string
  consequence: string
  observedAt: Date | string | null
  deadline: { at: Date | string; kind: 'DUE' | 'EXPIRES' } | null
  occurrenceCount: number
  founderResponseRequiredToProceed: boolean
}

function date(value: Date | string | null) {
  return value ? new Date(value).toLocaleString() : 'Not recorded'
}

function age(value: Date | string | null, generatedAt: Date | string) {
  if (!value) return 'Age not recorded'
  const minutes = Math.max(
    0,
    Math.floor((new Date(generatedAt).getTime() - new Date(value).getTime()) / 60_000),
  )
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h old`
  return `${Math.floor(hours / 24)}d old`
}

export function FounderDecisionContext({
  context,
  generatedAt,
}: {
  context: DecisionContext
  generatedAt: Date | string
}) {
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-white/10 pt-4 text-sm sm:grid-cols-2">
      <div className="sm:col-span-2">
        <dt className="font-semibold text-slate-200">Why this needs attention</dt>
        <dd className="mt-1 leading-5 text-slate-400">{context.attentionReason}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="font-semibold text-slate-200">If it stays open</dt>
        <dd className="mt-1 leading-5 text-slate-400">{context.consequence}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-200">Observed</dt>
        <dd className="mt-1 text-slate-400">
          {age(context.observedAt, generatedAt)} · {date(context.observedAt)}
        </dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-200">Founder response gate</dt>
        <dd className="mt-1 text-slate-400">
          {context.founderResponseRequiredToProceed
            ? 'Required for this work to proceed'
            : 'No response gate is recorded'}
        </dd>
      </div>
      {context.deadline ? (
        <div>
          <dt className="font-semibold text-slate-200">
            {context.deadline.kind === 'DUE' ? 'Due' : 'Approval expires'}
          </dt>
          <dd className="mt-1 text-slate-400">{date(context.deadline.at)}</dd>
        </div>
      ) : null}
      {context.occurrenceCount > 1 ? (
        <div>
          <dt className="font-semibold text-slate-200">Grouped evidence</dt>
          <dd className="mt-1 text-slate-400">{context.occurrenceCount} recorded occurrences</dd>
        </div>
      ) : null}
    </dl>
  )
}
