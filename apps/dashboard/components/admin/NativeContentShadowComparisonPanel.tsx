'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Run = {
  id: string
  createdAt: Date | string
  completedAt: Date | string | null
  modelProvider: string
  modelName: string
}

type Comparison = {
  status: 'INCOMPARABLE' | 'COMPARABLE' | 'COMPARABLE_WITH_DECLARED_CHANGE'
  mismatchReasons: string[]
  declaredChangeReasons: string[]
  cases: Array<{
    caseKey: string
    caseRevision: number
    category: string
    classification: string
    latencyDeltaMs: number | null
    costDeltaE8Usd: string | null
    scoreDeltaBasisPoints: number | null
  }>
  totals: null | {
    caseCount: number
    newFailures: number
    resolvedFailures: number
    unchangedFailures: number
    missingResults: number
    latencyDeltaMs: number
    costDeltaE8Usd: string
  }
  advisoryOnly: true
  guestReadPathChanged: false
  cutoverAuthorized: false
  legacyRetirementAuthorized: false
  readSwitchContract: {
    phase: 'EVIDENCE_INCOMPLETE' | 'POLICY_GATED'
    evidenceComplete: boolean
    executable: false
    readyForProductionSwitch: false
    blockers: string[]
    rollback: {
      targetGuestReadPath: 'LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT'
      compatibilityDataRetentionRequired: true
      rehearsalRequired: true
      automaticExecutionAuthorized: false
    }
  }
}

const classificationLabel: Record<string, string> = {
  NEW_FAILURE: 'New failure',
  RESOLVED_FAILURE: 'Resolved failure',
  UNCHANGED_FAILURE: 'Unchanged failure',
  UNCHANGED_PASS: 'Unchanged pass',
  BASELINE_RESULT_MISSING: 'Baseline result missing',
  CANDIDATE_RESULT_MISSING: 'Candidate result missing',
  BOTH_RESULTS_MISSING: 'Both results missing',
}

const blockerLabel: Record<string, string> = {
  NO_NATIVE_HEAD: 'No active native head exists.',
  INVALID_NATIVE_HEAD: 'Native head evidence is invalid.',
  MATERIALIZED_STATE_DRIFT: 'Materialized guest content has drifted from the native head.',
  TARGET_RELEASE_NOT_ACTIVE_HEAD: 'This release is not the exact active native head.',
  SHADOW_EVIDENCE_INCOMPARABLE: 'Frozen legacy/native evidence is incomparable.',
  SHADOW_RESULTS_MISSING: 'One or more frozen evaluation results are missing.',
  NEW_SHADOW_FAILURES: 'The native candidate introduced one or more evaluated failures.',
  QUALITY_THRESHOLD_POLICY_UNSET: 'Founder-approved quality thresholds are not defined.',
  READ_EXECUTOR_NOT_IMPLEMENTED: 'No guest read-path executor is implemented.',
  PRODUCTION_APPROVAL_REQUIRED: 'Production rollout still requires founder awareness/approval.',
  ROLLBACK_RUNTIME_NOT_PROVEN: 'The rollback runtime has not been rehearsed and proven.',
}

function runLabel(run: Run) {
  return `${new Date(run.createdAt).toLocaleString()} · ${run.modelProvider}/${run.modelName}`
}

function signed(value: number | null, unit: string) {
  if (value === null) return 'not comparable'
  return `${value > 0 ? '+' : ''}${value}${unit}`
}

export function NativeContentShadowComparisonPanel({
  tenantId,
  venueId,
  releaseId,
}: {
  tenantId: string
  venueId: string
  releaseId: string
}) {
  const client = useTRPCClient()
  const scope = `${tenantId}:${venueId}:${releaseId}`
  const renderedScope = useRef(scope)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const [runs, setRuns] = useState<{ baselines: Run[]; candidates: Run[] } | null>(null)
  const [baselineRunId, setBaselineRunId] = useState('')
  const [candidateRunId, setCandidateRunId] = useState('')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (renderedScope.current !== scope) {
    renderedScope.current = scope
    generation.current += 1
    inFlight.current = false
  }

  useEffect(() => {
    setRuns(null)
    setBaselineRunId('')
    setCandidateRunId('')
    setComparison(null)
    setBusy(false)
    setError(null)
    inFlight.current = false
  }, [scope])

  function current(startedGeneration: number, startedScope: string) {
    return generation.current === startedGeneration && renderedScope.current === startedScope
  }

  async function loadRuns() {
    if (inFlight.current) return
    inFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    setBusy(true)
    setError(null)
    try {
      const result = await client.admin.listNativeContentShadowRuns.query({
        tenantId,
        venueId,
        releaseId,
      })
      if (!current(startedGeneration, startedScope)) return
      setRuns(result)
      setBaselineRunId(result.baselines[0]?.id ?? '')
      setCandidateRunId(result.candidates[0]?.id ?? '')
    } catch {
      if (current(startedGeneration, startedScope))
        setError('Frozen shadow-run identities could not be loaded for this exact release.')
    } finally {
      if (current(startedGeneration, startedScope)) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!baselineRunId || !candidateRunId || inFlight.current) return
    inFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    setBusy(true)
    setError(null)
    setComparison(null)
    try {
      const result = await client.admin.compareNativeContentShadowRuns.query({
        tenantId,
        venueId,
        releaseId,
        baselineRunId,
        candidateRunId,
      })
      if (current(startedGeneration, startedScope)) setComparison(result as Comparison)
    } catch {
      if (current(startedGeneration, startedScope))
        setError('The exact frozen runs could not be compared. No release or guest state changed.')
    } finally {
      if (current(startedGeneration, startedScope)) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section
      aria-labelledby="native-shadow-heading"
      aria-busy={busy}
      className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5"
    >
      <h4 id="native-shadow-heading" className="font-semibold text-pf-deep">
        Legacy → native shadow comparison
      </h4>
      <p className="mt-2 text-sm leading-6 text-pf-deep/80">
        Compare the same frozen case corpus across the legacy guest-content snapshot and this exact
        native release. Model, prompt, corpus, and case evidence must still match.
      </p>

      {!runs ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void loadRuns()}
          className="mt-4 min-h-11 rounded-xl border border-pf-primary bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
        >
          {busy ? 'Loading frozen runs…' : 'Choose frozen runs'}
        </button>
      ) : runs.baselines.length === 0 || runs.candidates.length === 0 ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          A completed legacy baseline and a completed evaluation for this exact native release are
          both required. Run the same evaluation cases for each snapshot first.
        </p>
      ) : (
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={compare}>
          <label className="text-sm font-medium text-pf-deep">
            Legacy baseline
            <select
              aria-label="Legacy baseline run"
              value={baselineRunId}
              disabled={busy}
              onChange={(event) => {
                setBaselineRunId(event.target.value)
                setComparison(null)
              }}
              className="mt-2 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3"
            >
              {runs.baselines.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Native candidate
            <select
              aria-label="Native candidate run"
              value={candidateRunId}
              disabled={busy}
              onChange={(event) => {
                setCandidateRunId(event.target.value)
                setComparison(null)
              }}
              className="mt-2 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3"
            >
              {runs.candidates.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || !baselineRunId || !candidateRunId}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2 sm:w-fit"
          >
            {busy ? 'Comparing…' : 'Compare frozen evidence'}
          </button>
        </form>
      )}

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
        >
          {error}
        </p>
      ) : null}

      {comparison?.status === 'INCOMPARABLE' ? (
        <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="font-semibold text-amber-950">Evidence remains incomparable</p>
          <p className="mt-1 text-sm text-amber-900">
            Undeclared differences: {comparison.mismatchReasons.join(', ').toLowerCase()}.
          </p>
        </div>
      ) : comparison?.totals ? (
        <div className="mt-5 space-y-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Cases', comparison.totals.caseCount],
              ['New failures', comparison.totals.newFailures],
              ['Resolved failures', comparison.totals.resolvedFailures],
              ['Missing results', comparison.totals.missingResults],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-white p-3">
                <dt className="text-xs font-semibold text-pf-deep/65">{label}</dt>
                <dd className="mt-1 text-lg font-semibold text-pf-deep">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-pf-deep/65">
            Raw deltas: latency {signed(comparison.totals.latencyDeltaMs, ' ms')} · cost{' '}
            {signed(Number(comparison.totals.costDeltaE8Usd), ' e-8 USD')}. No pass threshold is
            inferred.
          </p>
          <ul aria-label="Shadow comparison cases" className="space-y-2">
            {comparison.cases.map((item) => (
              <li
                key={`${item.caseKey}:${item.caseRevision}`}
                className="rounded-xl bg-white p-3 text-sm"
              >
                <span className="font-semibold text-pf-deep">{item.caseKey}</span>{' '}
                <span className="text-pf-deep/65">
                  · {classificationLabel[item.classification] ?? item.classification} · score{' '}
                  {signed(item.scoreDeltaBasisPoints, ' bp')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {comparison ? (
        <section
          aria-labelledby="read-switch-contract-heading"
          className="mt-5 rounded-xl border border-violet-200 bg-white p-4"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h5 id="read-switch-contract-heading" className="font-semibold text-pf-deep">
                Non-executable read-switch contract
              </h5>
              <p className="mt-1 text-sm leading-6 text-pf-deep/70">
                {comparison.readSwitchContract.evidenceComplete
                  ? 'The selected evidence is structurally complete; unresolved policy and runtime gates remain.'
                  : 'The selected evidence is incomplete and policy/runtime gates also remain.'}
              </p>
            </div>
            <span className="w-fit rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-950">
              {comparison.readSwitchContract.phase === 'POLICY_GATED'
                ? 'Policy gated'
                : 'Evidence incomplete'}
            </span>
          </div>
          <ul className="mt-3 space-y-1 text-sm leading-6 text-pf-deep/75">
            {comparison.readSwitchContract.blockers.map((blocker) => (
              <li key={blocker}>• {blockerLabel[blocker] ?? blocker}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-5 text-pf-deep/65">
            Rollback target: retained compatibility retrieval. Compatibility data must remain,
            rollback must be rehearsed, and automatic rollback is not yet authorized.
          </p>
        </section>
      ) : null}

      <p className="mt-4 text-xs leading-5 text-pf-deep/65">
        Advisory measurement only. This comparison does not switch guest retrieval, authorize a
        cutover, or permit compatibility-data retirement.
      </p>
    </section>
  )
}
