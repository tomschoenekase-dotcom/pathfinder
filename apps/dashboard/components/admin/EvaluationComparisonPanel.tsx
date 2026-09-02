'use client'

import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const COMPARISON_READ_TIMEOUT_MS = 15_000

type RunOption = {
  id: string
  identityHash: string
  createdAt: Date
  modelProvider: string
  modelName: string
}

type Comparison = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['compareEvaluationRuns']['query']>
>

const classificationLabels = {
  NEW_FAILURE: 'New failure',
  RESOLVED_FAILURE: 'Resolved failure',
  UNCHANGED_FAILURE: 'Unchanged failure',
  UNCHANGED_PASS: 'Unchanged pass',
  BASELINE_RESULT_MISSING: 'Baseline result missing',
  CANDIDATE_RESULT_MISSING: 'Candidate result missing',
  BOTH_RESULTS_MISSING: 'Both results missing',
} as const

function signed(value: number | null, unit = '') {
  if (value === null) return 'Not comparable'
  return `${value > 0 ? '+' : ''}${value.toLocaleString()}${unit}`
}

function cost(value: string | null) {
  if (value === null) return 'Not comparable'
  const amount = BigInt(value)
  return `${amount > 0n ? '+' : ''}${amount.toString()} × 10⁻⁸ USD`
}

function HumanConclusionForm({
  tenantId,
  venueId,
  runId,
  runIdentityHash,
  resultId,
  initialRevision,
  caseLabel,
}: {
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
  resultId: string
  initialRevision: number
  caseLabel: string
}) {
  const client = useTRPCClient()
  const [decision, setDecision] = useState<'ACCEPTED' | 'REJECTED' | 'NEEDS_FOLLOW_UP'>(
    'NEEDS_FOLLOW_UP',
  )
  const [conclusion, setConclusion] = useState('')
  const [revision, setRevision] = useState(initialRevision)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const command = useRef<{ fingerprint: string; id: string } | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const scope = `${tenantId}:${venueId}:${runId}:${runIdentityHash}:${resultId}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useLayoutEffect(() => {
    generation.current += 1
    setDecision('NEEDS_FOLLOW_UP')
    setConclusion('')
    setRevision(initialRevision)
    setBusy(false)
    inFlight.current = false
    setNotice(null)
    command.current = null
  }, [tenantId, venueId, runId, runIdentityHash, resultId, initialRevision])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = conclusion.trim()
    if (!normalized || inFlight.current) return
    inFlight.current = true
    const fingerprint = JSON.stringify([
      runId,
      runIdentityHash,
      resultId,
      revision,
      decision,
      normalized,
    ])
    if (command.current?.fingerprint !== fingerprint)
      command.current = { fingerprint, id: crypto.randomUUID() }
    setBusy(true)
    setNotice(null)
    const current = ++generation.current
    const submittedScope = scope
    try {
      const saved = await client.admin.appendEvaluationConclusion.mutate({
        tenantId,
        venueId,
        runId,
        expectedRunIdentityHash: runIdentityHash,
        resultId,
        expectedRevision: revision,
        operationId: command.current.id,
        decision,
        conclusion: normalized,
        rubricVersion: 'operator-v1',
      })
      if (current === generation.current && submittedScope === scopeRef.current) {
        setRevision(saved.revision)
        setConclusion('')
        command.current = null
        setNotice(
          saved.replayed ? 'This exact conclusion was already recorded.' : 'Conclusion recorded.',
        )
      }
    } catch (error) {
      if (current === generation.current && submittedScope === scopeRef.current)
        setNotice(
          error instanceof Error
            ? `${error.message} Refresh the comparison before changing this conclusion.`
            : 'Conclusion could not be recorded. Retry the unchanged form or refresh.',
        )
    } finally {
      if (current === generation.current && submittedScope === scopeRef.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <form className="mt-4 space-y-3 border-t border-pf-light pt-4" onSubmit={submit}>
      <p className="text-xs font-semibold text-pf-deep/65">
        Append human conclusion · current revision {revision}
      </p>
      <label className="block text-xs font-medium text-pf-deep">
        Decision for {caseLabel}
        <select
          aria-label={`Decision for ${caseLabel}`}
          className="mt-1 min-h-10 w-full rounded-xl border border-pf-light bg-white px-3"
          value={decision}
          disabled={busy}
          onChange={(event) => {
            setDecision(event.target.value as typeof decision)
            setNotice(null)
          }}
        >
          <option value="ACCEPTED">Accepted</option>
          <option value="REJECTED">Rejected</option>
          <option value="NEEDS_FOLLOW_UP">Needs follow-up</option>
        </select>
      </label>
      <label className="block text-xs font-medium text-pf-deep">
        Conclusion for {caseLabel}
        <textarea
          aria-label={`Conclusion for ${caseLabel}`}
          className="mt-1 block w-full rounded-xl border border-pf-light px-3 py-2"
          maxLength={1000}
          required
          rows={3}
          value={conclusion}
          disabled={busy}
          onChange={(event) => {
            setConclusion(event.target.value)
            setNotice(null)
          }}
        />
      </label>
      <button
        type="submit"
        disabled={busy || !conclusion.trim()}
        className="min-h-10 rounded-xl bg-pf-primary px-4 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Recording…' : 'Record conclusion'}
      </button>
      {notice ? (
        <p className="text-xs leading-5 text-pf-deep/70" role="status">
          {notice}
        </p>
      ) : null}
    </form>
  )
}

export function EvaluationComparisonPanel({
  tenantId,
  venueId,
  runs,
}: {
  tenantId: string
  venueId: string
  runs: RunOption[]
}) {
  const client = useTRPCClient()
  const [baselineRunId, setBaselineRunId] = useState(runs[1]?.id ?? '')
  const [candidateRunId, setCandidateRunId] = useState(runs[0]?.id ?? '')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const activeRequest = useRef<AbortController | null>(null)
  const scope = `${tenantId}:${venueId}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    generation.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setBaselineRunId(runs[1]?.id ?? '')
    setCandidateRunId(runs[0]?.id ?? '')
    setComparison(null)
    setError(null)
    setBusy(false)
    inFlight.current = false
  }, [tenantId, venueId, runs])

  useEffect(
    () => () => {
      generation.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    },
    [],
  )

  function resetComparison() {
    generation.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    inFlight.current = false
    setComparison(null)
    setError(null)
    setBusy(false)
  }

  async function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!baselineRunId || !candidateRunId || baselineRunId === candidateRunId || inFlight.current)
      return
    inFlight.current = true
    const current = ++generation.current
    const submittedScope = scope
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setBusy(true)
    setError(null)
    setComparison(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: COMPARISON_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.compareEvaluationRuns.query(
            {
              tenantId,
              venueId,
              baselineRunId,
              candidateRunId,
            },
            { signal },
          ),
      })
      if (current === generation.current && submittedScope === scopeRef.current)
        setComparison(result)
    } catch {
      if (current === generation.current && submittedScope === scopeRef.current)
        setError('Comparison evidence could not be loaded in time. Retry the frozen run pair.')
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (current === generation.current && submittedScope === scopeRef.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
        Run comparison
      </p>
      <h3 className="mt-1 text-xl font-semibold text-pf-deep">Compare frozen evidence</h3>
      <p className="mt-2 text-sm leading-6 text-pf-deep/65">
        Comparisons fail closed unless corpus, content, package, model, prompt, configuration, and
        exact case revisions match. This evidence does not approve or block a package.
      </p>
      {runs.length < 2 ? (
        <p className="mt-4 rounded-2xl bg-pf-surface px-4 py-5 text-sm text-pf-deep/65">
          Two stored runs are required for comparison.
        </p>
      ) : (
        <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={compare}>
          <label className="text-sm font-medium text-pf-deep">
            Baseline run
            <select
              aria-label="Baseline run"
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
              value={baselineRunId}
              onChange={(event) => {
                resetComparison()
                setBaselineRunId(event.target.value)
              }}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.createdAt.toLocaleString()} · {run.modelProvider}/{run.modelName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Candidate run
            <select
              aria-label="Candidate run"
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
              value={candidateRunId}
              onChange={(event) => {
                resetComparison()
                setCandidateRunId(event.target.value)
              }}
            >
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.createdAt.toLocaleString()} · {run.modelProvider}/{run.modelName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || baselineRunId === candidateRunId}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2 sm:w-fit"
          >
            {busy ? 'Comparing…' : 'Compare runs'}
          </button>
        </form>
      )}
      {error ? (
        <p
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {comparison?.status === 'INCOMPARABLE' ? (
        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="font-semibold text-amber-950">Runs are incomparable</p>
          <p className="mt-1 text-sm text-amber-900">
            Frozen evidence differs: {comparison.mismatchReasons.join(', ').toLowerCase()}.
          </p>
        </div>
      ) : null}
      {comparison?.status === 'COMPARABLE' ? (
        <div className="mt-6 space-y-5">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['New failures', comparison.totals.newFailures],
              ['Resolved failures', comparison.totals.resolvedFailures],
              ['Missing results', comparison.totals.missingResults],
              ['Latency delta', signed(comparison.totals.latencyDeltaMs, ' ms')],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-pf-surface p-3">
                <dt className="text-xs font-semibold text-pf-deep/60">{label}</dt>
                <dd className="mt-1 text-lg font-semibold text-pf-deep">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-pf-deep/60">
            Total cost delta: {cost(comparison.totals.costDeltaE8Usd)}
          </p>
          <ul className="space-y-4" aria-label="Per-case comparison">
            {comparison.cases.map((row) => (
              <li
                key={`${row.caseKey}:${row.caseRevision}`}
                className="rounded-2xl border border-pf-light p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-pf-deep">{row.caseKey}</p>
                    <p className="mt-1 text-xs text-pf-deep/60">
                      {row.category} · revision {row.caseRevision}
                    </p>
                  </div>
                  <span className="rounded-full bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep">
                    {classificationLabels[row.classification]}
                  </span>
                </div>
                <p className="mt-3 text-xs text-pf-deep/65">
                  Latency {signed(row.latencyDeltaMs, ' ms')} · Cost {cost(row.costDeltaE8Usd)} ·
                  Score {signed(row.scoreDeltaBasisPoints, ' bp')}
                </p>
                {row.candidate ? (
                  <HumanConclusionForm
                    key={`${tenantId}:${venueId}:${comparison.candidate.id}:${row.candidate.resultId}`}
                    tenantId={tenantId}
                    venueId={venueId}
                    runId={comparison.candidate.id}
                    runIdentityHash={comparison.candidate.identityHash}
                    resultId={row.candidate.resultId}
                    initialRevision={row.candidate.latestReviewRevision}
                    caseLabel={`${row.caseKey}, revision ${row.caseRevision}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
