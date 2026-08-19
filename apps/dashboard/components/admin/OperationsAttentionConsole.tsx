import Link from 'next/link'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type Data = inferRouterOutputs<AppRouter>['admin']['attentionConsole']
type Cursor = { createdAt: string; id: string }

function date(value: Date | string | null) {
  return value ? new Date(value).toLocaleString() : 'Not recorded'
}

function nextHref(param: string, value: Cursor) {
  const query = new URLSearchParams({
    [param]: `${value.createdAt}|${value.id}`,
  })
  return `/admin/operations?${query.toString()}`
}

function More({ param, cursor, label }: { param: string; cursor: Cursor | null; label: string }) {
  return cursor ? (
    <Link
      href={nextHref(param, cursor)}
      className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-sky-800 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {label}
    </Link>
  ) : null
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
      {children}
    </p>
  )
}

function countLabel(page: { items: unknown[]; nextCursor: Cursor | null }) {
  return `${page.items.length}${page.nextCursor ? '+' : ''}`
}

export function OperationsAttentionConsole({ data }: { data: Data }) {
  return (
    <div className="space-y-6" aria-label="Operational attention queues">
      <p className="text-xs text-slate-500">
        Snapshot generated {date(data.generatedAt)}. This console is read-only.
      </p>

      <section
        aria-label="AI organization summary"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        {[
          [
            'Needs you',
            countLabel(data.questions),
            'text-amber-900',
            'border-amber-200 bg-amber-50',
          ],
          [
            'Working now',
            countLabel(data.workingAgents),
            'text-sky-900',
            'border-sky-200 bg-sky-50',
          ],
          [
            'Blocked / problems',
            countLabel(data.blockedAgents),
            'text-rose-900',
            'border-rose-200 bg-rose-50',
          ],
          [
            'Completed',
            countLabel(data.completedAgents),
            'text-emerald-900',
            'border-emerald-200 bg-emerald-50',
          ],
          [
            'Outcome signals',
            countLabel(data.outcomes),
            'text-violet-900',
            'border-violet-200 bg-violet-50',
          ],
        ].map(([label, value, textTone, surface]) => (
          <div key={label} className={`rounded-2xl border p-4 ${surface}`}>
            <p className={`text-xs font-bold uppercase tracking-wider ${textTone}`}>{label}</p>
            <p className={`mt-2 text-2xl font-semibold ${textTone}`}>{value}</p>
          </div>
        ))}
      </section>

      <section
        className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm"
        aria-labelledby="needs-you-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="needs-you-heading" className="text-xl font-semibold text-slate-950">
              Needs you
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Questions only a human currently needs to answer. Approvals remain a separate
              authority queue below.
            </p>
          </div>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">
            {countLabel(data.questions)} waiting
          </span>
        </div>
        {data.questions.items.length === 0 ? (
          <div className="mt-4">
            <Empty>No agents are waiting for human input.</Empty>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {data.questions.items.map((question) => (
              <article
                key={question.id}
                className="rounded-xl border border-amber-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                  <span>{question.agentIdentity.name}</span>
                  <span>·</span>
                  <span>{question.blocking ? 'Blocking' : 'Non-blocking'}</span>
                  <span>·</span>
                  <span>{date(question.createdAt)}</span>
                </div>
                <h3 className="mt-2 font-semibold text-slate-950">{question.question}</h3>
                {question.context ? (
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">
                    {question.context}
                  </p>
                ) : null}
                <Link
                  className="mt-3 inline-block text-sm font-semibold text-sky-700"
                  href={`/admin/clients/${question.tenantId}/venues/${question.venueId}/agents#inbox`}
                >
                  Answer in agent workspace
                </Link>
              </article>
            ))}
          </div>
        )}
        <More param="questionsCursor" cursor={data.questions.nextCursor} label="Older questions" />
      </section>

      <section className="space-y-4" aria-labelledby="agent-work-heading">
        <div>
          <h2 id="agent-work-heading" className="text-xl font-semibold text-slate-950">
            AI organization
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Meaningful work grouped by lifecycle. Detailed messages, artifacts, and tool evidence
            load only in the run view.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          {[
            {
              title: 'Working now',
              empty: 'No agent work is queued or running.',
              page: data.workingAgents,
              param: 'workingAgentsCursor',
              tone: 'border-sky-200',
            },
            {
              title: 'Blocked / problems',
              empty: 'No agent runs are blocked or failed.',
              page: data.blockedAgents,
              param: 'blockedAgentsCursor',
              tone: 'border-rose-200',
            },
            {
              title: 'Completed',
              empty: 'No completed agent runs are recorded.',
              page: data.completedAgents,
              param: 'completedAgentsCursor',
              tone: 'border-emerald-200',
            },
          ].map((group) => (
            <section
              key={group.title}
              className={`rounded-2xl border bg-white p-5 shadow-sm ${group.tone}`}
            >
              <h3 className="font-semibold text-slate-950">{group.title}</h3>
              {group.page.items.length === 0 ? (
                <div className="mt-4">
                  <Empty>{group.empty}</Empty>
                </div>
              ) : (
                <ul className="mt-4 space-y-3">
                  {group.page.items.map((run) => (
                    <li key={run.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-950">{run.requestedOperation}</p>
                          <p className="text-xs text-slate-500">
                            {run.agentIdentity.name} · {run.runType}
                          </p>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                          {run.status.replaceAll('_', ' ')}
                        </span>
                      </div>
                      {'errorCode' in run && run.errorCode ? (
                        <p className="mt-2 text-xs font-semibold text-rose-700">{run.errorCode}</p>
                      ) : null}
                      {'_count' in run && run._count ? (
                        <p className="mt-2 text-xs text-slate-500">
                          {run._count.outcomeObservations} outcome signals
                        </p>
                      ) : null}
                      {run.venueId ? (
                        <Link
                          className="mt-2 inline-block text-sm font-semibold text-sky-700"
                          href={`/admin/clients/${run.tenantId}/venues/${run.venueId}/agents/runs/${run.id}`}
                        >
                          Open run evidence
                        </Link>
                      ) : (
                        <Link
                          className="mt-2 inline-block text-sm font-semibold text-sky-700"
                          href={`/admin/clients/${run.tenantId}`}
                        >
                          Open client
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <More
                param={group.param}
                cursor={group.page.nextCursor}
                label={`Older ${group.title.toLowerCase()}`}
              />
            </section>
          ))}
        </div>
      </section>

      <section
        className="rounded-2xl border border-violet-200 bg-white p-5 shadow-sm"
        aria-labelledby="outcomes-heading"
      >
        <h2 id="outcomes-heading" className="font-semibold text-slate-950">
          Recent outcome evidence
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Explicit human or business signals—not completion counts.
        </p>
        {data.outcomes.items.length === 0 ? (
          <div className="mt-4">
            <Empty>No outcome observations are recorded yet.</Empty>
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 xl:grid-cols-2">
            {data.outcomes.items.map((outcome) => (
              <li
                key={outcome.id}
                className="rounded-xl border border-violet-100 bg-violet-50/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                  <span>{outcome.agentIdentity.name}</span>
                  <span>·</span>
                  <span>{outcome.verdict}</span>
                  <span>·</span>
                  <span>{outcome.taskClass}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-700">
                  {outcome.summary}
                </p>
                <Link
                  className="mt-3 inline-block text-sm font-semibold text-sky-700"
                  href={`/admin/clients/${outcome.tenantId}/venues/${outcome.venueId}/agents/runs/${outcome.agentRunId}`}
                >
                  Open outcome evidence
                </Link>
              </li>
            ))}
          </ul>
        )}
        <More
          param="outcomesCursor"
          cursor={data.outcomes.nextCursor}
          label="Older outcome evidence"
        />
      </section>

      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        aria-labelledby="job-attention-heading"
      >
        <h2 id="job-attention-heading" className="font-semibold text-slate-950">
          Failed and retry-eligible jobs
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Metadata only; payloads and raw errors are intentionally omitted.
        </p>
        {data.jobs.items.length === 0 ? (
          <div className="mt-4">
            <Empty>No failed job records need attention.</Empty>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {data.jobs.items.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-slate-950">{job.jobName}</p>
                  <p className="text-xs text-slate-500">
                    {job.queue} · attempt {job.attemptNumber ?? '?'} / {job.maxAttempts ?? '?'}
                  </p>
                </div>
                <div className="text-xs sm:text-right">
                  <p className="font-semibold text-rose-700">
                    {job.failureDisposition?.replaceAll('_', ' ') ?? 'FAILED'}
                  </p>
                  <p className="text-slate-500">{date(job.createdAt)}</p>
                  {job.tenantId ? (
                    <Link
                      className="font-semibold text-sky-700"
                      href={`/admin/clients/${job.tenantId}`}
                    >
                      Open client
                    </Link>
                  ) : (
                    <span className="text-slate-500">Platform scoped</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <More param="jobsCursor" cursor={data.jobs.nextCursor} label="Older failed jobs" />
      </section>

      <div>
        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          aria-labelledby="evaluation-attention-heading"
        >
          <h2 id="evaluation-attention-heading" className="font-semibold text-slate-950">
            Evaluation attention
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Failed, staged, retry-scheduled, or running with an expired lease.
          </p>
          {data.evaluations.items.length === 0 ? (
            <div className="mt-4">
              <Empty>No evaluation runs currently match the attention criteria.</Empty>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.evaluations.items.map((run) => (
                <li key={run.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {run.status.replaceAll('_', ' ')}
                      </p>
                      <p className="text-xs text-slate-500">
                        Attempt {run.attemptNumber} / {run.maxAttempts ?? '?'}
                      </p>
                    </div>
                    {run.expiredLease ? (
                      <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-800">
                        Lease expired
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {run.lastErrorCode ? `Error code ${run.lastErrorCode} · ` : ''}
                    {date(run.createdAt)}
                  </p>
                  <Link
                    className="mt-2 inline-block text-sm font-semibold text-sky-700"
                    href={`/admin/clients/${run.tenantId}/venues/${run.venueId}/evaluations`}
                  >
                    Open evaluation evidence
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <More
            param="evaluationsCursor"
            cursor={data.evaluations.nextCursor}
            label="Older evaluation attention"
          />
        </section>

        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          aria-labelledby="approval-attention-heading"
        >
          <h2 id="approval-attention-heading" className="font-semibold text-slate-950">
            Pending approvals
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Undecided requests, including requests whose decision window expired.
          </p>
          {data.approvals.items.length === 0 ? (
            <div className="mt-4">
              <Empty>No undecided approval requests are recorded.</Empty>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.approvals.items.map((approval) => (
                <li key={approval.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold text-slate-950">{approval.proposedAction}</p>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-semibold ${approval.expired ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}
                    >
                      {approval.expired ? 'Expired' : 'Pending'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {approval.agentIdentity.name} · {approval.riskCategory} risk ·{' '}
                    {date(approval.createdAt)}
                  </p>
                  {approval.venueId ? (
                    <Link
                      className="mt-2 inline-block text-sm font-semibold text-sky-700"
                      href={`/admin/clients/${approval.tenantId}/venues/${approval.venueId}/agents`}
                    >
                      Open agent approvals
                    </Link>
                  ) : (
                    <Link
                      className="mt-2 inline-block text-sm font-semibold text-sky-700"
                      href={`/admin/clients/${approval.tenantId}`}
                    >
                      Open client
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <More
            param="approvalsCursor"
            cursor={data.approvals.nextCursor}
            label="Older pending approvals"
          />
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          aria-labelledby="support-attention-heading"
        >
          <h2 id="support-attention-heading" className="font-semibold text-slate-950">
            Support workflow attention
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Waiting-for-client, validation, and approval states; messages and internal notes are
            omitted.
          </p>
          {data.support.items.length === 0 ? (
            <div className="mt-4">
              <Empty>No support requests currently match the attention criteria.</Empty>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.support.items.map((request) => (
                <li key={request.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{request.subject}</p>
                    {request.onboardingQuestionLink ? (
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-900">
                        Onboarding blocker
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {request.status.replaceAll('_', ' ')} · {request.category.replaceAll('_', ' ')}{' '}
                    · version {request.version}
                  </p>
                  <Link
                    className="mt-2 inline-block text-sm font-semibold text-sky-700"
                    href={`/admin/clients/${request.tenantId}/venues/${request.venueId}/support-operations?requestId=${request.id}`}
                  >
                    Open scoped request
                  </Link>
                  {request.onboardingQuestionLink ? (
                    <Link
                      className="ml-4 mt-2 inline-block text-sm font-semibold text-sky-700"
                      href={`/admin/clients/${request.tenantId}/venues/${request.venueId}/agents#inbox`}
                    >
                      Open blocked work
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <More
            param="supportCursor"
            cursor={data.support.nextCursor}
            label="Older support attention"
          />
        </section>
      </div>
    </div>
  )
}
