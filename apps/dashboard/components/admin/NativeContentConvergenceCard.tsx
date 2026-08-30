import React from 'react'

type ConvergencePhase =
  | 'NO_NATIVE_HEAD'
  | 'NATIVE_HEAD_INVALID'
  | 'NATIVE_HEAD_DRIFTED'
  | 'NATIVE_HEAD_IN_SYNC'
type ConvergenceBlocker =
  | 'NO_NATIVE_HEAD'
  | 'INVALID_NATIVE_HEAD'
  | 'MATERIALIZED_STATE_DRIFT'
  | 'LEGACY_SEMANTIC_READ_PATH'

export type NativeContentConvergence = {
  phase: ConvergencePhase
  readyForShadowEvaluation: boolean
  needsOperatorAttention: boolean
  blockers: readonly ConvergenceBlocker[]
  counts: {
    activePlaces: number
    enabledKnowledgeEntries: number
    publishedGeneralizedModules: number
  }
}

const phaseCopy: Record<ConvergencePhase, { title: string; detail: string }> = {
  NO_NATIVE_HEAD: {
    title: 'No native release is active',
    detail: 'Guest content still operates from the compatibility tables.',
  },
  NATIVE_HEAD_INVALID: {
    title: 'Native head evidence is inconsistent',
    detail: 'Keep lifecycle actions paused until the release evidence is repaired.',
  },
  NATIVE_HEAD_DRIFTED: {
    title: 'Materialized content has drifted',
    detail: 'Current guest-visible state no longer matches the exact native head.',
  },
  NATIVE_HEAD_IN_SYNC: {
    title: 'Native head and materialized content match',
    detail: 'This venue is ready for shadow evaluation, not legacy retirement.',
  },
}

const blockerCopy: Record<ConvergenceBlocker, string> = {
  NO_NATIVE_HEAD: 'Apply and verify a native release before measuring parity.',
  INVALID_NATIVE_HEAD: 'Repair inconsistent native head and release evidence.',
  MATERIALIZED_STATE_DRIFT: 'Reconcile current guest-visible content with the native head.',
  LEGACY_SEMANTIC_READ_PATH: 'Guest semantic search still depends on compatibility tables.',
}

export function NativeContentConvergenceCard({
  convergence,
}: {
  convergence: NativeContentConvergence | null
}) {
  if (!convergence) {
    return (
      <section
        aria-labelledby="content-convergence-heading"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-5"
      >
        <h3 id="content-convergence-heading" className="font-semibold text-amber-950">
          Content convergence unavailable
        </h3>
        <p className="mt-1 text-sm leading-6 text-amber-900">
          The read-only comparison could not be completed. No content or release state changed.
        </p>
      </section>
    )
  }

  const copy = phaseCopy[convergence.phase]
  const attention = convergence.needsOperatorAttention
  return (
    <section
      aria-labelledby="content-convergence-heading"
      className={`rounded-2xl border p-5 ${
        attention ? 'border-rose-200 bg-rose-50' : 'border-pf-light bg-white'
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Legacy-to-native convergence
          </p>
          <h3 id="content-convergence-heading" className="mt-1 font-semibold text-pf-deep">
            {copy.title}
          </h3>
          <p className="mt-1 text-sm leading-6 text-pf-deep/75">{copy.detail}</p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            attention ? 'bg-rose-100 text-rose-900' : 'bg-pf-surface text-pf-deep'
          }`}
        >
          {convergence.readyForShadowEvaluation ? 'Shadow-ready' : 'Not shadow-ready'}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ['Active places', convergence.counts.activePlaces],
          ['Knowledge entries', convergence.counts.enabledKnowledgeEntries],
          ['Published modules', convergence.counts.publishedGeneralizedModules],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl bg-pf-surface px-4 py-3">
            <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/65">
              {label}
            </dt>
            <dd className="mt-1 text-xl font-semibold text-pf-deep">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 rounded-xl border border-pf-light bg-white/80 p-4">
        <p className="text-sm font-semibold text-pf-deep">Retirement blockers</p>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-pf-deep/75">
          {convergence.blockers.map((blocker) => (
            <li key={blocker}>• {blockerCopy[blocker]}</li>
          ))}
        </ul>
      </div>

      <p className="mt-3 text-xs leading-5 text-pf-deep/65">
        Measurement only. This page does not switch guest retrieval, delete compatibility data, or
        authorize a production cutover.
      </p>
    </section>
  )
}
