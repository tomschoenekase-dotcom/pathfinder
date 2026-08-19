import Link from 'next/link'

import { formatE8Usd } from './AgentOperationsOverview'
import { AgentRunCancellationControl } from './AgentRunCancellationControl'
import { AgentOutcomeObservationForm } from './AgentOutcomeObservationForm'

type Cursor = { createdAt: string; id: string } | null
type Run = {
  id: string
  runType: string
  requestedOperation: string
  requestPrompt?: string | null
  parentAgentRunId?: string | null
  delegationReason?: string | null
  artifacts?: unknown
  status: string
  modelProvider: string | null
  modelName: string | null
  costE8Usd: bigint
  errorCode: string | null
  errorMessage: string | null
  initiatedByType: string
  initiatedById: string
  cancelRequestedAt: Date | null
  attemptNumber?: number
  maxAttempts?: number
  lastHeartbeatAt?: Date | null
  executionLeaseExpiresAt?: Date | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  agentIdentity: { id: string; name: string; enabled: boolean }
  parentAgentRun?: { id: string; agentIdentity: { id: string; name: string } } | null
  delegatedRuns?: Array<{
    id: string
    status: string
    delegationReason: string | null
    createdAt: Date
    agentIdentity: { id: string; name: string }
  }>
  messages?: Array<{
    id: string
    role: string
    messageType: string
    content: string
    actorId: string
    createdAt: Date
  }>
  _count: {
    actions: number
    timelineEvents: number
    approvalRequests: number
    delegatedRuns?: number
    outcomeObservations?: number
  }
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
type OutcomeObservation = {
  id: string
  signalKind: string
  verdict: string
  summary: string
  evidenceRef: string | null
  taskClass: string
  modelProvider: string | null
  modelName: string | null
  actorType: string
  actorId: string
  createdAt: Date
}

type Props = {
  tenantId: string
  venueId: string
  run: Run
  actions: { items: Action[]; nextCursor: Cursor }
  timeline: { items: Timeline[]; nextCursor: Cursor }
  approvals: { items: Approval[]; nextCursor: Cursor }
  outcomes?: { items: OutcomeObservation[]; nextCursor: Cursor }
}

function nextHref(base: string, prefix: string, cursor: Exclude<Cursor, null>) {
  return `${base}?${prefix}CreatedAt=${encodeURIComponent(cursor.createdAt)}&${prefix}Id=${encodeURIComponent(cursor.id)}`
}
function date(value: Date | null | undefined) {
  return value ? value.toLocaleString() : 'Not recorded'
}

function resultArtifacts(value: unknown): Array<{ title: string; content: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((artifact) => {
    if (!artifact || typeof artifact !== 'object') return []
    const item = artifact as Record<string, unknown>
    if (typeof item.content !== 'string') return []
    return [
      {
        title: typeof item.title === 'string' ? item.title : 'Agent result',
        content: item.content.slice(0, 100_000),
      },
    ]
  })
}

export function AgentRunOperationsView({
  tenantId,
  venueId,
  run,
  actions,
  timeline,
  approvals,
  outcomes = { items: [], nextCursor: null },
}: Props) {
  const overview = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  const base = `${overview}/runs/${run.id}`
  const artifacts = resultArtifacts(run.artifacts)
  const delegatedRuns = run.delegatedRuns ?? []
  const messages = run.messages ?? []
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
          Lifecycle evidence and text results are visible to platform administrators. Raw action
          payloads, scope snapshots, and execution lease tokens remain hidden; requesting
          cancellation records intent only.
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
        <Summary label="Attempts" value={`${run.attemptNumber ?? 0} / ${run.maxAttempts ?? 3}`} />
        <Summary label="Delegated tasks" value={String(run._count.delegatedRuns ?? 0)} />
        <Summary label="Outcome signals" value={String(run._count.outcomeObservations ?? 0)} />
      </section>

      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
        <h3 className="text-xl font-semibold text-pf-deep">Lifecycle</h3>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Datum label="Created" value={date(run.createdAt)} />
          <Datum label="Started" value={date(run.startedAt)} />
          <Datum label="Completed" value={date(run.completedAt)} />
          <Datum label="Cancel requested" value={date(run.cancelRequestedAt)} />
          <Datum label="Last heartbeat" value={date(run.lastHeartbeatAt)} />
          <Datum label="Lease expires" value={date(run.executionLeaseExpiresAt)} />
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

      {run.requestPrompt ? (
        <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
          <h3 className="text-xl font-semibold text-pf-deep">Task</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-pf-deep/75">
            {run.requestPrompt}
          </p>
          {run.parentAgentRun ? (
            <p className="mt-4 text-sm text-pf-deep/60">
              Delegated by{' '}
              <Link
                className="font-semibold text-pf-primary"
                href={`${overview}/runs/${run.parentAgentRun.id}`}
              >
                {run.parentAgentRun.agentIdentity.name}
              </Link>
              {run.delegationReason ? ` · ${run.delegationReason}` : ''}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-4" aria-labelledby="conversation-heading">
        <div>
          <h3 id="conversation-heading" className="text-xl font-semibold text-pf-deep">
            Conversation
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Prompts, operator answers, and agent results in chronological order.
          </p>
        </div>
        {messages.length ? (
          <ol className="space-y-3">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`max-w-4xl rounded-3xl border p-5 ${
                  message.role === 'OPERATOR'
                    ? 'ml-auto border-sky-200 bg-sky-50'
                    : message.role === 'AGENT'
                      ? 'mr-auto border-emerald-200 bg-emerald-50/50'
                      : 'mx-auto border-pf-light bg-white'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-pf-deep/55">
                  <span>{message.role}</span>
                  <span>·</span>
                  <span>{message.messageType}</span>
                  <span>·</span>
                  <span>{message.createdAt.toLocaleString()}</span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-pf-deep/80">
                  {message.content}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <Empty text="No conversational messages are recorded for this run yet." />
        )}
      </section>

      <section className="space-y-4" aria-labelledby="run-results-heading">
        <div>
          <h3 id="run-results-heading" className="text-xl font-semibold text-pf-deep">
            Results
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Text artifacts returned by the execution adapter.
          </p>
        </div>
        {artifacts.length ? (
          artifacts.map((artifact, index) => (
            <article
              key={`${artifact.title}-${index}`}
              className="rounded-3xl border border-emerald-200 bg-emerald-50/40 p-5"
            >
              <h4 className="font-semibold text-pf-deep">{artifact.title}</h4>
              <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-pf-deep/80">
                {artifact.content}
              </pre>
            </article>
          ))
        ) : (
          <Empty text="No readable result artifacts are recorded yet." />
        )}
      </section>

      {['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) ? (
        <AgentOutcomeObservationForm tenantId={tenantId} venueId={venueId} agentRunId={run.id} />
      ) : null}

      <section className="space-y-4" aria-labelledby="run-outcomes-heading">
        <div>
          <h3 id="run-outcomes-heading" className="text-xl font-semibold text-pf-deep">
            Outcome evidence
          </h3>
          <p className="mt-1 text-sm text-pf-deep/60">
            Append-only observations used to evaluate this agent, model, and task class. These are
            distinct from execution completion.
          </p>
        </div>
        {outcomes.items.length ? (
          <ol className="space-y-3">
            {outcomes.items.map((outcome) => (
              <li key={outcome.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">
                    {outcome.verdict.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs font-semibold text-pf-deep/55">
                    {outcome.signalKind.replace(/_/g, ' ')} · {outcome.createdAt.toLocaleString()}
                  </span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-pf-deep/75">
                  {outcome.summary}
                </p>
                <p className="mt-3 text-xs text-pf-deep/55">
                  {outcome.taskClass} ·{' '}
                  {[outcome.modelProvider, outcome.modelName].filter(Boolean).join(' / ') ||
                    'No model recorded'}
                </p>
                {outcome.evidenceRef ? (
                  <p className="mt-2 break-all font-mono text-xs text-pf-deep/55">
                    Evidence: {outcome.evidenceRef}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <Empty text="No outcome evidence is recorded. Completion is not being counted as quality." />
        )}
        {outcomes.nextCursor ? (
          <Older
            href={nextHref(base, 'outcomeCursor', outcomes.nextCursor)}
            label="Older outcome evidence"
          />
        ) : null}
      </section>

      {delegatedRuns.length ? (
        <section className="space-y-4" aria-labelledby="delegated-runs-heading">
          <h3 id="delegated-runs-heading" className="text-xl font-semibold text-pf-deep">
            Specialists on this job
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {delegatedRuns.map((child) => (
              <Link
                key={child.id}
                href={`${overview}/runs/${child.id}`}
                className="rounded-2xl border border-pf-light bg-white p-4 shadow-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-pf-primary">{child.agentIdentity.name}</span>
                  <span className="text-xs font-bold text-pf-deep/60">
                    {child.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="mt-2 text-sm text-pf-deep/65">
                  {child.delegationReason ?? 'No delegation reason recorded.'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

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
