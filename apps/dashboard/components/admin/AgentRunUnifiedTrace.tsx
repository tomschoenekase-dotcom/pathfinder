import Link from 'next/link'

import { formatE8Usd } from './AgentOperationsOverview'

type TraceCursor = {
  createdAt: string
  kind: 'ACTION' | 'EVENT' | 'APPROVAL' | 'OUTCOME'
  id: string
}

type TraceItem = {
  id: string
  createdAt: Date
  kind: 'ACTION' | 'EVENT' | 'APPROVAL' | 'OUTCOME'
  actorType?: string
  actorId?: string
  actionName?: string
  requestedOperation?: string
  inputSummary?: string | null
  status?: string
  modelProvider?: string | null
  modelName?: string | null
  costE8Usd?: bigint
  errorCode?: string | null
  beforeVersionRef?: string | null
  afterVersionRef?: string | null
  approvalDecisionId?: string | null
  eventType?: string
  message?: string | null
  agentActionId?: string | null
  proposedAction?: string
  reason?: string
  riskCategory?: string
  state?: string
  expiresAt?: Date | null
  decision?: { decision: string; reason: string | null; createdAt: Date } | null
  signalKind?: string
  verdict?: string
  summary?: string
  evidenceRef?: string | null
  taskClass?: string
}

type Props = {
  base: string
  trace: {
    items: TraceItem[]
    nextCursor: TraceCursor | null
    bounded: true
    excludes: readonly string[]
  }
}

function words(value: string) {
  return value.replace(/_/g, ' ')
}

function title(item: TraceItem) {
  if (item.kind === 'ACTION') return item.actionName ?? 'Agent action'
  if (item.kind === 'EVENT') return words(item.eventType ?? 'Lifecycle event')
  if (item.kind === 'APPROVAL') return item.proposedAction ?? 'Approval request'
  return `${words(item.signalKind ?? 'Outcome')} · ${words(item.verdict ?? 'Recorded')}`
}

function description(item: TraceItem) {
  if (item.kind === 'ACTION') return item.inputSummary ?? 'No input summary recorded.'
  if (item.kind === 'EVENT') return item.message ?? 'No event message recorded.'
  if (item.kind === 'APPROVAL') return item.reason ?? 'No approval reason recorded.'
  return item.summary ?? 'No outcome summary recorded.'
}

function traceHref(base: string, cursor: TraceCursor) {
  const params = new URLSearchParams({
    traceCursorCreatedAt: cursor.createdAt,
    traceCursorKind: cursor.kind,
    traceCursorId: cursor.id,
  })
  return `${base}?${params.toString()}`
}

export function AgentRunUnifiedTrace({ base, trace }: Props) {
  return (
    <section className="space-y-4" aria-labelledby="unified-run-trace-heading">
      <div>
        <h3 id="unified-run-trace-heading" className="text-xl font-semibold text-pf-deep">
          Unified run trace
        </h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-pf-deep/60">
          Actions, lifecycle events, approvals, and outcome evidence in one exact
          reverse-chronological view. This is a bounded, read-only summary; raw payloads, scope
          snapshots, and execution leases remain excluded.
        </p>
      </div>
      {trace.items.length ? (
        <ol className="relative space-y-3 border-l border-pf-light pl-4 sm:pl-6">
          {trace.items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="relative">
              <span
                className="absolute -left-[1.31rem] top-6 h-2.5 w-2.5 rounded-full border-2 border-white bg-pf-primary sm:-left-[1.81rem]"
                aria-hidden="true"
              />
              <article className="rounded-2xl border border-pf-light bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold tracking-wide text-slate-800">
                      {item.kind}
                    </span>
                    <h4 className="mt-2 break-words font-semibold text-pf-deep">{title(item)}</h4>
                  </div>
                  <time
                    className="text-xs font-medium text-pf-deep/55"
                    dateTime={item.createdAt.toISOString()}
                  >
                    {item.createdAt.toLocaleString()}
                  </time>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-pf-deep/70">
                  {description(item)}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-pf-deep/55">
                  {item.actorType ? (
                    <span>
                      {item.actorType}
                      {item.actorId ? ` · ${item.actorId}` : ''}
                    </span>
                  ) : null}
                  {item.status ? <span>Status: {words(item.status)}</span> : null}
                  {item.state ? <span>Decision state: {words(item.state)}</span> : null}
                  {item.riskCategory ? <span>{words(item.riskCategory)} risk</span> : null}
                  {item.requestedOperation ? <span>{words(item.requestedOperation)}</span> : null}
                  {item.costE8Usd !== undefined ? <span>{formatE8Usd(item.costE8Usd)}</span> : null}
                  {item.modelProvider || item.modelName ? (
                    <span>{[item.modelProvider, item.modelName].filter(Boolean).join(' / ')}</span>
                  ) : null}
                </div>
                {item.decision ? (
                  <p className="mt-2 text-sm font-medium text-pf-deep">
                    {words(item.decision.decision)}
                    {item.decision.reason ? ` · ${item.decision.reason}` : ''}
                  </p>
                ) : null}
                {item.beforeVersionRef || item.afterVersionRef ? (
                  <p className="mt-2 break-all font-mono text-xs text-pf-deep/55">
                    {item.beforeVersionRef ?? 'No prior version'} →{' '}
                    {item.afterVersionRef ?? 'No resulting version'}
                  </p>
                ) : null}
                {item.evidenceRef ? (
                  <p className="mt-2 break-all font-mono text-xs text-pf-deep/55">
                    Evidence: {item.evidenceRef}
                  </p>
                ) : null}
                {item.errorCode ? (
                  <p className="mt-2 text-xs text-rose-700">{item.errorCode}</p>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/65">
          No action, lifecycle, approval, or outcome evidence is recorded for this run yet.
        </div>
      )}
      {trace.nextCursor ? (
        <div className="flex justify-end">
          <Link
            href={traceHref(base, trace.nextCursor)}
            className="inline-flex min-h-11 items-center rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Older trace evidence
          </Link>
        </div>
      ) : null}
    </section>
  )
}
