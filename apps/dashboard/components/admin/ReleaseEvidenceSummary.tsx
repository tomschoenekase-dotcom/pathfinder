import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import {
  ReleaseEvidenceGates,
  ReleaseEvidenceLimitations,
  ReleaseRollbackEvidence,
  StagingHandoffEvidence,
} from '@pathfinder/contracts/release-evidence'

type Evidence = inferRouterOutputs<AppRouter>['admin']['releaseEvidence']

function shortRevision(revision: string) {
  return revision.slice(0, 8)
}

function readable(value: string) {
  return value.replaceAll('-', ' ')
}

export function ReleaseEvidenceSummary({ evidence }: { evidence: Evidence }) {
  const current = evidence.current
  if (!current) {
    return (
      <section
        aria-labelledby="release-evidence-heading"
        className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:p-5"
      >
        <p className="text-xs font-bold uppercase tracking-wider text-amber-800">
          Release evidence
        </p>
        <h2 id="release-evidence-heading" className="mt-1 text-lg font-semibold text-slate-950">
          No release assessment is recorded
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-700">
          Code or filesystem artifacts are not treated as deployed evidence until an exact,
          attributable assessment is recorded here.
        </p>
      </section>
    )
  }

  const handoff = StagingHandoffEvidence.safeParse(current.stagingHandoff)
  const rollback = ReleaseRollbackEvidence.safeParse(current.rollback)
  const limitations = ReleaseEvidenceLimitations.safeParse(current.limitations)
  const gates = ReleaseEvidenceGates.safeParse(current.gates)
  const ready = current.readiness === 'ready-for-staging-review'

  return (
    <section
      aria-labelledby="release-evidence-heading"
      className={`rounded-2xl border p-4 sm:p-5 ${
        ready ? 'border-sky-200 bg-sky-50/70' : 'border-amber-200 bg-amber-50/70'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-600">
            Exact release evidence
          </p>
          <h2 id="release-evidence-heading" className="mt-1 text-lg font-semibold text-slate-950">
            Candidate {shortRevision(current.revision)} · {readable(current.readiness)}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-700">
            Immutable assessment evidence for one exact repository revision. This record does not
            deploy an application, run a migration, contact a customer, or authorize production.
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-bold uppercase ${
            ready ? 'bg-sky-100 text-sky-900' : 'bg-amber-100 text-amber-900'
          }`}
        >
          Evidence only
        </span>
      </div>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-white/80 bg-white/70 p-3">
          <dt className="text-xs font-semibold text-slate-500">Assessment</dt>
          <dd className="mt-1 text-sm font-bold text-slate-950">
            {current.passed} passed · {current.failed} failed · {current.blocked} blocked
          </dd>
        </div>
        <div className="rounded-xl border border-white/80 bg-white/70 p-3">
          <dt className="text-xs font-semibold text-slate-500">Repository</dt>
          <dd className="mt-1 text-sm font-bold text-slate-950">
            {current.repositoryClean ? 'Clean exact revision' : 'Dirty; not admissible'}
          </dd>
        </div>
        <div className="rounded-xl border border-white/80 bg-white/70 p-3">
          <dt className="text-xs font-semibold text-slate-500">Staging handoff</dt>
          <dd className="mt-1 text-sm font-bold text-slate-950">
            {handoff.success ? readable(handoff.data.status) : 'Not recorded'}
          </dd>
        </div>
        <div className="rounded-xl border border-white/80 bg-white/70 p-3">
          <dt className="text-xs font-semibold text-slate-500">Recorded by</dt>
          <dd className="mt-1 break-words text-sm font-bold text-slate-950">
            {current.recordedByType.toLowerCase()} · {current.recordedById}
          </dd>
        </div>
      </dl>

      {handoff.success ? (
        <p className="mt-4 text-xs leading-5 text-slate-700">
          Handoff spans {handoff.data.changedFiles} changed files and {handoff.data.migrationCount}{' '}
          migrations through <code>{handoff.data.latestMigration}</code>. Base is
          {handoff.data.baseIsAncestor ? '' : ' not'} an ancestor; lineage is {handoff.data.ahead}{' '}
          ahead and {handoff.data.behind} behind.
        </p>
      ) : null}

      <details className="mt-4 rounded-xl border border-white/80 bg-white/70 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          Gates, limits, and rollback
        </summary>
        <div className="mt-3 grid gap-4 text-xs leading-5 text-slate-700 lg:grid-cols-3">
          <div>
            <h3 className="font-bold text-slate-900">Gate evidence</h3>
            <p className="mt-1">
              {gates.success
                ? `${gates.data.length} named gates retained; ${gates.data.filter((gate) => gate.status !== 'pass').length} need attention.`
                : 'Stored gate detail is unavailable.'}
            </p>
          </div>
          <div>
            <h3 className="font-bold text-slate-900">Known limits</h3>
            {limitations.success && limitations.data.length > 0 ? (
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {limitations.data.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1">No bounded limitation detail was retained.</p>
            )}
          </div>
          <div>
            <h3 className="font-bold text-slate-900">Rollback</h3>
            {rollback.success ? (
              <dl className="mt-1 space-y-1">
                <div>
                  <dt className="font-semibold">Application</dt>
                  <dd>{rollback.data.application}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Database</dt>
                  <dd>{rollback.data.database}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Runbook</dt>
                  <dd>
                    <code>{rollback.data.runbook}</code>
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1">Rollback detail is unavailable.</p>
            )}
          </div>
        </div>
      </details>

      {evidence.items.length > 1 ? (
        <p className="mt-3 text-xs text-slate-600">
          {evidence.items.length - 1} earlier immutable assessment
          {evidence.items.length === 2 ? '' : 's'} retained in this bounded view.
        </p>
      ) : null}
    </section>
  )
}
