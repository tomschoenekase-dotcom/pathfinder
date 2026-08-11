type WeeklyReportLifecycleEvidenceProps = {
  evidence: {
    scope: { tenantId: string; venueId: string; reportId: string }
    version: string
    status: 'QUEUED' | 'RUNNING' | 'REVIEW' | 'PUBLISHED' | 'FAILED'
    legacyStatus: string
    executionEnabled: boolean
    report: {
      generatedAt: Date | null
      publishedAt: Date | null
      answerCount: number
      sessionCount: number
      error: string | null
    }
    dispatch: {
      id: string
      status: string
      attempts: number
      lastError: string | null
      createdAt: Date
      updatedAt: Date
    } | null
    jobs: {
      id: string
      jobName: string
      status: string
      error: string | null
      attemptNumber: number | null
      maxAttempts: number | null
      failureDisposition: string | null
      startedAt: Date
      completedAt: Date | null
      terminalAt: Date | null
    }[]
    audits: { id: string; actorId: string; actorRole: string; action: string; createdAt: Date }[]
  } | null
}

export function WeeklyReportLifecycleEvidence({ evidence }: WeeklyReportLifecycleEvidenceProps) {
  if (!evidence)
    return (
      <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6" role="status">
        <h2 className="font-semibold text-amber-950">Lifecycle evidence unavailable</h2>
        <p className="mt-2 text-sm text-amber-900">
          The report remains available, but operator-only execution evidence could not be loaded. No
          lifecycle action was taken.
        </p>
      </section>
    )
  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-6 shadow-sm"
      aria-labelledby="report-lifecycle-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Operator evidence
          </p>
          <h2 id="report-lifecycle-heading" className="mt-1 text-xl font-semibold text-pf-deep">
            Report lifecycle
          </h2>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">
          {evidence.status}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-pf-deep/55">Execution</dt>
          <dd className="font-semibold text-pf-deep">
            {evidence.executionEnabled ? 'Enabled' : 'Dark / default-off'}
          </dd>
        </div>
        <div>
          <dt className="text-pf-deep/55">Legacy state</dt>
          <dd className="font-semibold text-pf-deep">{evidence.legacyStatus}</dd>
        </div>
        <div>
          <dt className="text-pf-deep/55">Version</dt>
          <dd className="break-all font-mono text-xs text-pf-deep">{evidence.version}</dd>
        </div>
      </dl>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-pf-surface p-4">
          <h3 className="font-semibold text-pf-deep">Dispatch and jobs</h3>
          <p className="mt-2 text-sm text-pf-deep/70">
            {evidence.dispatch
              ? `${evidence.dispatch.status} · ${evidence.dispatch.attempts} dispatch attempt(s)`
              : 'No durable dispatch evidence.'}
          </p>
          {evidence.jobs.length ? (
            <ul className="mt-3 space-y-2">
              {evidence.jobs.map((job) => (
                <li key={job.id} className="text-xs text-pf-deep/70">
                  <span className="font-semibold">
                    {job.jobName}: {job.status}
                  </span>
                  {job.attemptNumber !== null
                    ? ` · attempt ${job.attemptNumber}/${job.maxAttempts ?? '?'}`
                    : ''}
                  {job.failureDisposition ? ` · ${job.failureDisposition}` : ''}
                  {job.error ? <span className="mt-1 block text-rose-700">{job.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-pf-deep/55">No worker attempts recorded.</p>
          )}
        </div>
        <div className="rounded-2xl bg-pf-surface p-4">
          <h3 className="font-semibold text-pf-deep">Immutable audit trail</h3>
          {evidence.audits.length ? (
            <ul className="mt-3 space-y-2">
              {evidence.audits.map((audit) => (
                <li key={audit.id} className="text-xs text-pf-deep/70">
                  <span className="font-semibold">{audit.action}</span> · {audit.actorRole} ·{' '}
                  {audit.createdAt.toLocaleString()}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-pf-deep/55">No report audit events recorded.</p>
          )}
        </div>
      </div>
      <p className="mt-4 text-xs text-pf-deep/50">
        Scope: {evidence.scope.tenantId} / {evidence.scope.venueId} / {evidence.scope.reportId}. Raw
        job payloads and report content are intentionally omitted here.
      </p>
    </section>
  )
}
