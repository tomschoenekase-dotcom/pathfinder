import Link from 'next/link'

import { formatE8Usd } from './AgentOperationsOverview'
import { AgentRunCancellationControl } from './AgentRunCancellationControl'

type Cursor = { createdAt: string; id: string } | null
type Run = {
  id: string
  runType: string
  requestedOperation: string
  status: string
  modelProvider: string | null
  modelName: string | null
  costE8Usd: bigint
  errorCode: string | null
  errorMessage: string | null
  initiatedByType: string
  initiatedById: string
  cancelRequestedAt: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  agentIdentity: { id: string; name: string; enabled: boolean }
  _count: { actions: number; timelineEvents: number; approvalRequests: number }
}
type Action = {
  id: string
  actorType: string
  requestedOperation: string
  actionName: string
  inputSummary: string | null
  modelProvider: string | null
  modelName: string | null
  costE8Usd: bigint
  status: string
  errorCode: string | null
  errorMessage: string | null
  beforeVersionRef: string | null
  afterVersionRef: string | null
  approvalDecisionId: string | null
  createdAt: Date
}
type Timeline = {
  id: string
  actorType: string
  eventType: string
  message: string | null
  agentActionId: string | null
  createdAt: Date
}
type Approval = {
  id: string
  proposedAction: string
  reason: string
  riskCategory: string
  state: string
  expiresAt: Date | null
  createdAt: Date
  decision: { decision: string; reason: string | null; createdAt: Date } | null
}

type Props = {
  tenantId: string
  venueId: string
  run: Run
  actions: { items: Action[]; nextCursor: Cursor }
  timeline: { items: Timeline[]; nextCursor: Cursor }
  approvals: { items: Approval[]; nextCursor: Cursor }
}

function nextHref(base: string, prefix: string, cursor: Exclude<Cursor, null>) {
  return `${base}?${prefix}CreatedAt=${encodeURIComponent(cursor.createdAt)}&${prefix}Id=${encodeURIComponent(cursor.id)}`
}
function date(value: Date | null) {
  return value ? value.toLocaleString() : 'Not recorded'
}

export function AgentRunOperationsView({
  tenantId,
  venueId,
  run,
  actions,
  timeline,
  approvals,
}: Props) {
  const overview = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  const base = `${overview}/runs/${run.id}`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <Link
          href={overview}
          className="text-sm font-semibold text-pf-primary hover:text-pf-accent"
        >
          ← Agent operations
        </Link>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="font-mono text-xs text-pf-deep/55">{run.id}</p>
            <h2 className="mt-1 text-2xl font-semibold text-pf-deep">{run.agentIdentity.name}</h2>
            <p className="mt-1 text-sm text-pf-deep/65">
              {run.requestedOperation} · {run.runType.replace(/_/g, ' ')}
            </p>
          </div>
          <span className="self-start rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-800">
            {run.status.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          Lifecycle evidence is read-only except for the cancellation-intent control. Raw inputs,
          outputs, artifacts, and scope snapshots are not exposed here; requesting cancellation
          records intent only.
        </p>
      </header>

      <AgentRunCancellationControl
        tenantId={tenantId}
        venueId={venueId}
        agentRunId={run.id}
        status={run.status}
        cancelRequestedAt={run.cancelRequestedAt}
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Run summary">
        <Summary label="Cost" value={formatE8Usd(run.costE8Usd)} />
        <Summary
          label="Model"
          value={[run.modelProvider, run.modelName].filter(Boolean).join(' / ') || 'Not recorded'}
        />
        <Summary label="Actions" value={String(run._count.actions)} />
        <Summary label="Approvals" value={String(run._count.approvalRequests)} />
      </section>

      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
        <h3 className="text-xl font-semibold text-pf-deep">Lifecycle</h3>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Datum label="Created" value={date(run.createdAt)} />
          <Datum label="Started" value={date(run.startedAt)} />
          <Datum label="Completed" value={date(run.completedAt)} />
          <Datum label="Cancel requested" value={date(run.cancelRequestedAt)} />
          <Datum label="Initiated by" value={`${run.initiatedByType} · ${run.initiatedById}`} />
          <Datum label="Last updated" value={date(run.updatedAt)} />
          {run.errorCode ? (
            <Datum
              label="Error"
              value={`${run.errorCode}${run.errorMessage ? ` · ${run.errorMessage}` : ''}`}
            />
          ) : null}
        </dl>
      </section>

      <section className="space-y-4" aria-labelledby="run-actions-heading">
        <div>
          <h3 id="run-actions-heading" className="text-xl font-semibold text-pf-deep">
            Actions
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Bounded summaries and version references; raw action payloads remain hidden.
          </p>
        </div>
        {actions.items.length === 0 ? (
          <Empty text="No actions are recorded for this run." />
        ) : (
          <div className="space-y-3">
            {actions.items.map((action) => (
              <article key={action.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-pf-deep">{action.actionName}</h4>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">
                    {action.status}
                  </span>
                </div>
                <p className="mt-2 text-sm text-pf-deep/70">
                  {action.inputSummary ?? 'No input summary recorded.'}
                </p>
                <p className="mt-3 text-xs text-pf-deep/55">
                  {action.actorType} · {action.requestedOperation} · {formatE8Usd(action.costE8Usd)}{' '}
                  · {action.createdAt.toLocaleString()}
                </p>
                {action.beforeVersionRef || action.afterVersionRef ? (
                  <p className="mt-2 font-mono text-xs text-pf-deep/55">
                    {action.beforeVersionRef ?? 'No prior version'} →{' '}
                    {action.afterVersionRef ?? 'No resulting version'}
                  </p>
                ) : null}
                {action.errorCode ? (
                  <p className="mt-2 text-xs text-rose-700">
                    {action.errorCode}
                    {action.errorMessage ? ` · ${action.errorMessage}` : ''}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {actions.nextCursor ? (
          <Older href={nextHref(base, 'actionCursor', actions.nextCursor)} label="Older actions" />
        ) : null}
      </section>

      <section className="space-y-4" aria-labelledby="run-timeline-heading">
        <div>
          <h3 id="run-timeline-heading" className="text-xl font-semibold text-pf-deep">
            Timeline
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Recorded lifecycle events in reverse chronological order.
          </p>
        </div>
        {timeline.items.length === 0 ? (
          <Empty text="No timeline events are recorded for this run." />
        ) : (
          <ol className="space-y-3">
            {timeline.items.map((event) => (
              <li key={event.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-pf-deep">
                    {event.eventType.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-pf-deep/55">
                    {event.actorType} · {event.createdAt.toLocaleString()}
                  </span>
                </div>
                <p className="mt-2 text-sm text-pf-deep/70">
                  {event.message ?? 'No event message recorded.'}
                </p>
              </li>
            ))}
          </ol>
        )}
        {timeline.nextCursor ? (
          <Older
            href={nextHref(base, 'timelineCursor', timeline.nextCursor)}
            label="Older events"
          />
        ) : null}
      </section>

      <section className="space-y-4" aria-labelledby="run-approvals-heading">
        <div>
          <h3 id="run-approvals-heading" className="text-xl font-semibold text-pf-deep">
            Approval history
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Decision evidence only; no approval controls are available.
          </p>
        </div>
        {approvals.items.length === 0 ? (
          <Empty text="No approval requests are recorded for this run." />
        ) : (
          <ul className="space-y-3">
            {approvals.items.map((approval) => (
              <li key={approval.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-950">
                    {approval.state.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs font-semibold text-pf-deep/60">
                    {approval.riskCategory} risk
                  </span>
                </div>
                <p className="mt-2 font-semibold text-pf-deep">{approval.proposedAction}</p>
                <p className="mt-1 text-sm text-pf-deep/65">{approval.reason}</p>
                {approval.decision ? (
                  <p className="mt-3 text-sm text-pf-deep">
                    {approval.decision.decision.replace(/_/g, ' ')}
                    {approval.decision.reason ? ` · ${approval.decision.reason}` : ''}
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-pf-deep/55">
                    Expires: {date(approval.expiresAt)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {approvals.nextCursor ? (
          <Older
            href={nextHref(base, 'approvalCursor', approvals.nextCursor)}
            label="Older approvals"
          />
        ) : null}
      </section>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-pf-light bg-white p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-pf-deep/55">{label}</p>
      <p className="mt-2 break-words font-semibold text-pf-deep">{value}</p>
    </div>
  )
}
function Datum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-pf-deep/60">{label}</dt>
      <dd className="mt-1 break-words text-pf-deep">{value}</dd>
    </div>
  )
}
function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-pf-light bg-white p-8 text-center text-sm text-pf-deep/65">
      {text}
    </div>
  )
}
function Older({ href, label }: { href: string; label: string }) {
  return (
    <div className="flex justify-end">
      <Link
        href={href}
        className="inline-flex min-h-11 items-center rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
      >
        {label}
      </Link>
    </div>
  )
}
