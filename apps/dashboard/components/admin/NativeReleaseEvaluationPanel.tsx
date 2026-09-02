'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'

const EVALUATION_READ_TIMEOUT_MS = 15_000

type Case = {
  id: string
  caseKey: string
  revision: number
  category: string
}
type Evidence = {
  id: string
  runId: string
  disposition: 'PASS' | 'QUALITY_FAILURE' | 'OPERATIONAL_FAILURE'
  manifestCaseCount: number
  scoredCaseCount: number
  passedCaseCount: number
  failedCaseCount: number
  operationalFailureCount: number
  totalLatencyMs: number
  totalCostE8Usd: string
  runCompletedAt: Date | string
  createdAt: Date | string
  advisoryOnly: true
}
type Cursor = { createdAt: Date | string; id: string }

function disposition(value: Evidence['disposition']): string {
  return value === 'PASS'
    ? 'Quality checks passed'
    : value === 'QUALITY_FAILURE'
      ? 'Quality checks found failures'
      : 'Operational failure; quality was not fully scored'
}

function usd(e8: string): string {
  const value = BigInt(e8)
  return `$${(Number(value) / 100_000_000).toFixed(4)}`
}

function budgetE8(value: string): string | null {
  if (!/^(?:0|1)(?:\.\d{0,8})?$/u.test(value) || Number(value) > 1) return null
  const [whole, fraction = ''] = value.split('.')
  return (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0') || '0')).toString()
}

export function NativeReleaseEvaluationPanel({
  tenantId,
  venueId,
  releaseId,
  releaseVersion,
  releaseStatus,
  runner,
  initialEvidence,
}: {
  tenantId: string
  venueId: string
  releaseId: string
  releaseVersion: Date | string
  releaseStatus: string
  runner: {
    processEnabled: boolean
    requiresDurableGlobalAdmission: boolean
    requiresTenantAdmission: boolean
    maximumCases: number
    maximumBudgetE8Usd: string
    advisoryOnly: true
  }
  initialEvidence: { items: Evidence[]; hasMore: boolean; nextCursor: Cursor | null }
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const version = new Date(releaseVersion).toISOString()
  const scope = `${tenantId}:${venueId}:${releaseId}:${version}`
  const renderedScope = useRef(scope)
  const generation = useRef(0)
  const panelInFlight = useRef(false)
  const readAbort = useRef<AbortController | null>(null)
  const requestOperation = useRef(crypto.randomUUID())
  const evidenceOperations = useRef(new Map<string, string>())
  const [readyScope, setReadyScope] = useState(scope)
  const [cases, setCases] = useState<Case[]>([])
  const [caseCursor, setCaseCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [budget, setBudget] = useState('0.25')
  const [confirmed, setConfirmed] = useState(false)
  const [requestedRun, setRequestedRun] = useState<{ id: string; status: string } | null>(null)
  const [items, setItems] = useState(initialEvidence.items)
  const [evidenceCursor, setEvidenceCursor] = useState(initialEvidence.nextCursor)
  const [hasMore, setHasMore] = useState(initialEvidence.hasMore)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const feedbackHeading = useRef<HTMLHeadingElement>(null)

  if (renderedScope.current !== scope) {
    readAbort.current?.abort()
    readAbort.current = null
    renderedScope.current = scope
    generation.current += 1
    panelInFlight.current = false
    requestOperation.current = crypto.randomUUID()
    evidenceOperations.current.clear()
  }
  const scopeReady = readyScope === scope

  useEffect(() => {
    readAbort.current?.abort()
    readAbort.current = null
    generation.current += 1
    setReadyScope(scope)
    setCases([])
    setCaseCursor(null)
    setSelected(new Set())
    setBudget('0.25')
    setConfirmed(false)
    setRequestedRun(null)
    setItems(initialEvidence.items)
    setEvidenceCursor(initialEvidence.nextCursor)
    setHasMore(initialEvidence.hasMore)
    setBusy(null)
    setMessage(null)
    setError(null)
    panelInFlight.current = false
    requestOperation.current = crypto.randomUUID()
    evidenceOperations.current.clear()
    return () => {
      readAbort.current?.abort()
      readAbort.current = null
      generation.current += 1
      panelInFlight.current = false
    }
  }, [initialEvidence, scope])

  useEffect(() => {
    if (message || error) feedbackHeading.current?.focus()
  }, [message, error])

  function current(startedGeneration: number, startedScope: string) {
    return generation.current === startedGeneration && renderedScope.current === startedScope
  }

  async function loadCases(cursor: { createdAt: string; id: string } | null = null) {
    if (!scopeReady || panelInFlight.current) return
    panelInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const controller = new AbortController()
    readAbort.current = controller
    setBusy('cases')
    setError(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: EVALUATION_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listEvaluationCases.query(
            { tenantId, venueId, ...(cursor ? { cursor } : {}) },
            { signal },
          ),
      })
      if (!current(startedGeneration, startedScope)) return
      setCases((prior) => (cursor ? [...prior, ...page.items] : page.items))
      setCaseCursor(page.nextCursor)
    } catch {
      if (current(startedGeneration, startedScope))
        setError('Evaluation cases could not be loaded for this release scope.')
    } finally {
      if (readAbort.current === controller) readAbort.current = null
      if (current(startedGeneration, startedScope)) {
        panelInFlight.current = false
        setBusy(null)
      }
    }
  }

  async function request() {
    if (!scopeReady || panelInFlight.current || selected.size === 0) return
    const e8 = budgetE8(budget)
    if (e8 === null || BigInt(e8) > BigInt(runner.maximumBudgetE8Usd)) {
      setError('Enter a budget within the displayed maximum.')
      return
    }
    panelInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    setBusy('request')
    setError(null)
    setMessage(null)
    try {
      const result = await client.admin.requestNativeVenueDeploymentEvaluation.mutate({
        tenantId,
        venueId,
        releaseId,
        expectedReleaseUpdatedAt: new Date(releaseVersion),
        operationId: requestOperation.current,
        caseIds: [...selected],
        budgetCeilingE8Usd: e8,
      })
      if (!current(startedGeneration, startedScope)) return
      setRequestedRun({ id: result.runId, status: result.status })
      setConfirmed(false)
      setMessage(
        result.replayed
          ? 'This exact advisory evaluation request was already recorded.'
          : `Advisory evaluation requested. Current run status: ${result.status}.`,
      )
    } catch (cause) {
      if (!current(startedGeneration, startedScope)) return
      const code =
        cause &&
        typeof cause === 'object' &&
        'data' in cause &&
        cause.data &&
        typeof cause.data === 'object' &&
        'code' in cause.data &&
        typeof cause.data.code === 'string'
          ? cause.data.code
          : null
      if (code === 'CONFLICT' || code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') {
        requestOperation.current = crypto.randomUUID()
        setError(
          'This release, its evaluation cases, or execution availability changed. Reload before requesting evaluation.',
        )
      } else {
        setError(
          'The request outcome is unknown. Retry the unchanged selection with the same operation identity.',
        )
      }
    } finally {
      if (current(startedGeneration, startedScope)) {
        panelInFlight.current = false
        setBusy(null)
      }
    }
  }

  async function recordEvidence(runId: string) {
    if (!scopeReady || panelInFlight.current) return
    panelInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const operationId = evidenceOperations.current.get(runId) ?? crypto.randomUUID()
    evidenceOperations.current.set(runId, operationId)
    setBusy('evidence')
    setError(null)
    setMessage(null)
    try {
      const result = await client.admin.recordNativeVenueDeploymentEvaluationEvidence.mutate({
        tenantId,
        venueId,
        releaseId,
        runId,
        operationId,
      })
      if (!current(startedGeneration, startedScope)) return
      const recordedDisposition =
        result.disposition === 'PASS' ||
        result.disposition === 'QUALITY_FAILURE' ||
        result.disposition === 'OPERATIONAL_FAILURE'
          ? result.disposition.toLowerCase().replaceAll('_', ' ')
          : 'evaluation'
      setMessage(
        result.replayed
          ? 'This exact advisory evidence was already recorded.'
          : `Advisory ${recordedDisposition} evidence recorded.`,
      )
      setRequestedRun(null)
      router.refresh()
    } catch (cause) {
      if (!current(startedGeneration, startedScope)) return
      const code =
        cause &&
        typeof cause === 'object' &&
        'data' in cause &&
        cause.data &&
        typeof cause.data === 'object' &&
        'code' in cause.data &&
        typeof cause.data.code === 'string'
          ? cause.data.code
          : null
      if (code === 'PRECONDITION_FAILED' || code === 'CONFLICT' || code === 'NOT_FOUND') {
        evidenceOperations.current.delete(runId)
        setError(
          'Completed advisory evidence is not available for this exact run and release yet. Refresh its status before trying again.',
        )
      } else {
        setError(
          'The evidence outcome is unknown. Retry this unchanged run with the same operation identity.',
        )
      }
    } finally {
      if (current(startedGeneration, startedScope)) {
        panelInFlight.current = false
        setBusy(null)
      }
    }
  }

  async function loadMoreEvidence() {
    if (!scopeReady || !evidenceCursor || panelInFlight.current) return
    panelInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const controller = new AbortController()
    readAbort.current = controller
    setBusy('history')
    setError(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: EVALUATION_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listNativeVenueDeploymentEvaluationEvidence.query(
            {
              tenantId,
              venueId,
              releaseId,
              cursor: { createdAt: new Date(evidenceCursor.createdAt), id: evidenceCursor.id },
              limit: 10,
            },
            { signal },
          ),
      })
      if (!current(startedGeneration, startedScope)) return
      setItems((prior) => [...prior, ...page.items])
      setEvidenceCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch {
      if (current(startedGeneration, startedScope))
        setError('Older advisory evidence could not be loaded.')
    } finally {
      if (readAbort.current === controller) readAbort.current = null
      if (current(startedGeneration, startedScope)) {
        panelInFlight.current = false
        setBusy(null)
      }
    }
  }

  const requestableStatus = releaseStatus === 'DRAFT' || releaseStatus === 'APPROVED'
  return (
    <section
      aria-labelledby="native-evaluation-heading"
      aria-busy={busy !== null}
      className="rounded-2xl border border-sky-200 bg-sky-50/60 p-5"
    >
      <h4 id="native-evaluation-heading" className="font-semibold text-pf-deep">
        Advisory evaluation evidence
      </h4>
      <p className="mt-2 text-sm leading-6 text-pf-deep/80">
        Evaluation results are advisory. They do not approve, block, apply, revert, or change this
        native release.
      </p>
      <p className="mt-2 text-xs leading-5 text-pf-deep/65">
        Requests require process availability
        {runner.requiresDurableGlobalAdmission ? ', durable global admission' : ''}
        {runner.requiresTenantAdmission ? ', and exact tenant admission' : ''}. These are
        requirements, not claims that admission is currently enabled.
      </p>

      {!runner.processEnabled || !requestableStatus ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          {!runner.processEnabled
            ? 'Evaluation execution is not enabled for this API process.'
            : 'New advisory evaluation requests are available only for draft or approved native releases.'}
        </p>
      ) : cases.length === 0 ? (
        <button
          type="button"
          disabled={!scopeReady || busy !== null}
          onClick={() => void loadCases()}
          className="mt-4 min-h-11 rounded-xl border border-pf-primary bg-white px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
        >
          {busy === 'cases' ? 'Loading cases…' : 'Choose evaluation cases'}
        </button>
      ) : (
        <div className="mt-4 space-y-4">
          <fieldset disabled={!scopeReady || busy !== null} className="space-y-2">
            <legend className="text-sm font-semibold text-pf-deep">
              Cases ({selected.size}/{runner.maximumCases})
            </legend>
            {cases.map((item) => (
              <label
                key={item.id}
                className="flex min-h-11 items-start gap-3 rounded-xl border border-sky-200 bg-white p-3"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(item.id)}
                  onChange={(event) =>
                    setSelected((prior) => {
                      const next = new Set(prior)
                      if (event.target.checked && next.size < runner.maximumCases) next.add(item.id)
                      else if (!event.target.checked) next.delete(item.id)
                      requestOperation.current = crypto.randomUUID()
                      setConfirmed(false)
                      return next
                    })
                  }
                />
                <span>
                  <span className="block text-sm font-semibold text-pf-deep">{item.caseKey}</span>
                  <span className="text-xs text-pf-deep/65">
                    {item.category} · revision {item.revision}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {caseCursor ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void loadCases(caseCursor)}
              className="min-h-11 text-sm font-semibold text-pf-primary underline"
            >
              Load more cases
            </button>
          ) : null}
          <label className="block text-sm font-semibold text-pf-deep">
            Budget ceiling (USD, maximum {usd(runner.maximumBudgetE8Usd)})
            <input
              aria-label="Native evaluation budget ceiling"
              value={budget}
              disabled={busy !== null}
              onChange={(event) => {
                setBudget(event.target.value)
                requestOperation.current = crypto.randomUUID()
                setConfirmed(false)
              }}
              inputMode="decimal"
              className="mt-2 block min-h-11 w-full max-w-xs rounded-xl border border-sky-200 bg-white px-3"
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-pf-deep/80">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy !== null || requestedRun !== null}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1"
            />
            I confirm these cases and budget will evaluate this exact release version’s frozen
            desired state. The result is advisory and does not control its lifecycle.
          </label>
          <button
            type="button"
            disabled={busy !== null || selected.size === 0 || !confirmed || requestedRun !== null}
            onClick={() => void request()}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === 'request'
              ? 'Requesting…'
              : 'Request evaluation of this release’s frozen desired state'}
          </button>
        </div>
      )}

      {requestedRun ? (
        <div className="mt-4 rounded-xl border border-sky-200 bg-white p-4">
          <p className="text-sm text-pf-deep">
            Requested run status: <strong>{requestedRun.status}</strong>
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void recordEvidence(requestedRun.id)}
            className="mt-3 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
          >
            {busy === 'evidence' ? 'Checking…' : 'Check and record completed evidence'}
          </button>
        </div>
      ) : null}

      <div className="mt-5">
        <h5 className="text-sm font-semibold text-pf-deep">Recorded advisory evidence</h5>
        {items.length ? (
          <ul className="mt-2 space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-sky-100 bg-white p-4 text-sm text-pf-deep"
              >
                <p className="font-semibold">{disposition(item.disposition)}</p>
                <p className="mt-1 text-xs text-pf-deep/70">
                  {item.passedCaseCount} passed · {item.failedCaseCount} failed ·{' '}
                  {item.operationalFailureCount} operational failures · {item.scoredCaseCount} of{' '}
                  {item.manifestCaseCount} scored
                </p>
                <p className="mt-1 text-xs text-pf-deep/60">
                  Completed {new Date(item.runCompletedAt).toLocaleString()} · {item.totalLatencyMs}{' '}
                  ms · {usd(item.totalCostE8Usd)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-pf-deep/65">
            No advisory evaluation evidence has been recorded for this release.
          </p>
        )}
        {hasMore && evidenceCursor ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void loadMoreEvidence()}
            className="mt-3 min-h-11 text-sm font-semibold text-pf-primary underline"
          >
            {busy === 'history' ? 'Loading…' : 'Load older evidence'}
          </button>
        ) : null}
      </div>

      {message || error ? (
        <div className="mt-4" role={error ? 'alert' : 'status'}>
          <h5 ref={feedbackHeading} tabIndex={-1} className="text-sm font-semibold text-pf-deep">
            {error ? 'Evaluation needs attention' : 'Evaluation update'}
          </h5>
          <p className={`mt-1 text-sm ${error ? 'text-rose-800' : 'text-emerald-800'}`}>
            {error ?? message}
          </p>
        </div>
      ) : null}
    </section>
  )
}
