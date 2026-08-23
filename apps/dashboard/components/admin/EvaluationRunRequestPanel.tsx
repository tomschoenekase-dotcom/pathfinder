'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export type EvaluationCaseListItem = {
  id: string
  caseKey: string
  revision: number
  category: string
  schemaVersion: string
  sourceType: string
  sourceRef?: string
  createdAt: Date
}
type Cursor = { createdAt: string; id: string }
type SourceCoveragePreview = {
  contentSnapshotHash: string
  contentVersion: string
  cases: {
    caseId: string
    caseKey: string
    revision: number
    coverage: {
      supportedMarkers: number
      totalMarkers: number
      markers: {
        markerId: string
        kind: 'required-phrase' | 'required-fact'
        supported: boolean
        matchedPhrase: string | null
      }[]
    }
  }[]
}

export function evaluationBudgetToE8Usd(value: string): string | null {
  if (!/^(?:0|1)(?:\.\d{0,8})?$/u.test(value) || Number(value) > 1) return null
  const [whole, fraction = ''] = value.split('.')
  return (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0') || '0')).toString()
}

export function EvaluationRunRequestPanel(props: {
  tenantId: string
  venueId: string
  initialCases: EvaluationCaseListItem[]
  initialNextCursor: Cursor | null
  runnerEnabled: boolean
  regressionAlerts?: {
    configured: boolean
    minimumPassRateDrop: number | null
    errorPassRateDrop: number | null
  }
  maximumCases: number
  approvedPackages?: { id: string; payloadHash: string; approvedAt: Date | null }[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [cases, setCases] = useState(props.initialCases)
  const [nextCursor, setNextCursor] = useState(props.initialNextCursor)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [budget, setBudget] = useState('0.25')
  const [approvedPackageId, setApprovedPackageId] = useState(props.approvedPackages?.[0]?.id ?? '')
  const [message, setMessage] = useState<string | null>(null)
  const [sourceCoverage, setSourceCoverage] = useState<SourceCoveragePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())
  const submitting = useRef(false)
  const generation = useRef(0)
  const scope = `${props.tenantId}:${props.venueId}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const selectedPackage = props.approvedPackages?.find((pkg) => pkg.id === approvedPackageId)
  const expectedSourceRef = selectedPackage
    ? `venue-package:${selectedPackage.id}:${selectedPackage.payloadHash}`
    : null
  const latestOnboardingCases = [
    ...cases
      .filter(
        (item) =>
          item.sourceType === 'ONBOARDING_APPROVED_PACKAGE' &&
          expectedSourceRef !== null &&
          item.sourceRef === expectedSourceRef,
      )
      .reduce((latest, item) => {
        const prior = latest.get(item.caseKey)
        if (!prior || item.revision > prior.revision) latest.set(item.caseKey, item)
        return latest
      }, new Map<string, EvaluationCaseListItem>())
      .values(),
  ]

  useEffect(() => {
    generation.current += 1
    setCases(props.initialCases)
    setNextCursor(props.initialNextCursor)
    setSelected(new Set())
    setBudget('0.25')
    setApprovedPackageId(props.approvedPackages?.[0]?.id ?? '')
    setMessage(null)
    setSourceCoverage(null)
    setBusy(false)
    submitting.current = false
    idempotencyKey.current = crypto.randomUUID()
  }, [
    props.tenantId,
    props.venueId,
    props.initialCases,
    props.initialNextCursor,
    props.approvedPackages,
  ])

  async function loadMore() {
    if (!nextCursor || busy) return
    setBusy(true)
    setMessage(null)
    const currentGeneration = generation.current
    const requestedScope = scope
    try {
      const page = await client.admin.listEvaluationCases.query({
        tenantId: props.tenantId,
        venueId: props.venueId,
        cursor: nextCursor,
      })
      if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
      setCases((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current)
        setMessage('More cases could not be loaded. Your current selections are preserved.')
    } finally {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current)
        setBusy(false)
    }
  }

  async function submit() {
    if (submitting.current || !props.runnerEnabled) return
    const budgetCeilingE8Usd = evaluationBudgetToE8Usd(budget)
    if (selected.size < 1 || selected.size > props.maximumCases || budgetCeilingE8Usd === null) {
      setMessage(`Select 1–${props.maximumCases} cases and enter a budget from $0 to $1.`)
      return
    }
    submitting.current = true
    setBusy(true)
    setMessage(null)
    const currentGeneration = generation.current
    const requestedScope = scope
    try {
      const result = await client.admin.requestEvaluationRun.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        idempotencyKey: idempotencyKey.current,
        caseIds: [...selected],
        budgetCeilingE8Usd,
        ...(approvedPackageId ? { approvedPackageId } : {}),
      })
      if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
      if (result.dispatchPending) {
        setMessage(
          'Run staged. The durable worker dispatcher will publish it after rechecking global and tenant gates.',
        )
        idempotencyKey.current = crypto.randomUUID()
        router.refresh()
        return
      }
      try {
        await client.admin.listEvaluationRuns.query({
          tenantId: props.tenantId,
          venueId: props.venueId,
          limit: 1,
        })
        if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
        setMessage('Run queued. Refreshing the evidence list…')
      } catch {
        if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
        setMessage(
          'Run queueing was confirmed, but refreshed evidence could not be loaded yet. Do not resubmit; refresh this page.',
        )
      }
      if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
      idempotencyKey.current = crypto.randomUUID()
      router.refresh()
    } catch {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current)
        setMessage(
          'The request outcome is unknown. Your selections are preserved; refresh evaluation evidence before retrying with the same request.',
        )
    } finally {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }

  async function previewSourceCoverage() {
    if (busy || selected.size === 0 || approvedPackageId) return
    setBusy(true)
    setMessage(null)
    setSourceCoverage(null)
    const currentGeneration = generation.current
    const requestedScope = scope
    try {
      const result = await client.admin.previewCurrentEvaluationSourceCoverage.query({
        tenantId: props.tenantId,
        venueId: props.venueId,
        caseIds: [...selected],
      })
      if (currentGeneration !== generation.current || requestedScope !== scopeRef.current) return
      setSourceCoverage(result)
    } catch {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current)
        setMessage('Current source coverage could not be inspected. No evaluation was started.')
    } finally {
      if (currentGeneration === generation.current && requestedScope === scopeRef.current)
        setBusy(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="request-evaluation-heading"
    >
      <h3 id="request-evaluation-heading" className="text-xl font-semibold text-pf-deep">
        Request a bounded evaluation
      </h3>
      {!props.runnerEnabled ? (
        <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Evaluation execution is dark. The API process gate, durable global gate, and exact tenant
          gate must all be enabled before a run identity can be created or queued.
        </p>
      ) : null}
      {props.regressionAlerts?.configured ? (
        <p className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          Automatic same-corpus regression alerts use the explicit durable policy: warning at a{' '}
          {Math.round((props.regressionAlerts.minimumPassRateDrop ?? 0) * 1000) / 10}% pass-rate
          drop and error at{' '}
          {Math.round((props.regressionAlerts.errorPassRateDrop ?? 0) * 1000) / 10}%.
        </p>
      ) : (
        <p className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
          Automatic regression alerts are dark because no explicit durable threshold policy is
          configured. Stored runs can still be compared manually; Torchiko will not infer alert or
          severity thresholds.
        </p>
      )}
      {cases.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/65">
          No evaluation cases are ready for this venue.
        </p>
      ) : (
        <fieldset className="mt-4 space-y-2" disabled={busy}>
          <legend className="text-sm font-semibold text-pf-deep">
            Cases ({selected.size}/{props.maximumCases})
          </legend>
          {approvedPackageId ? (
            <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
              <button
                type="button"
                onClick={() => setSelected(new Set(latestOnboardingCases.map((item) => item.id)))}
                disabled={latestOnboardingCases.length !== 7}
                className="min-h-11 rounded-xl border border-sky-300 bg-white px-4 text-sm font-semibold text-sky-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select seven onboarding cases
              </button>
              <p className="mt-1 text-xs text-sky-950/75">
                {latestOnboardingCases.length === 7
                  ? 'Selects only the latest immutable revision tied to this exact package hash.'
                  : `${latestOnboardingCases.length} of 7 exact-package cases are ready. Prepare the suite above before requesting a run.`}
              </p>
            </div>
          ) : null}
          {cases.map((item) => (
            <label
              key={item.id}
              className="flex min-h-11 items-start gap-3 rounded-xl border border-pf-light p-3"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(item.id)}
                onChange={(event) => {
                  setSourceCoverage(null)
                  setSelected((current) => {
                    const next = new Set(current)
                    if (event.target.checked && next.size < props.maximumCases) next.add(item.id)
                    else if (!event.target.checked) next.delete(item.id)
                    return next
                  })
                }}
              />
              <span>
                <span className="block text-sm font-semibold text-pf-deep">{item.caseKey}</span>
                <span className="text-xs text-pf-deep/60">
                  {item.category} · revision {item.revision}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {nextCursor ? (
        <button
          type="button"
          onClick={loadMore}
          disabled={busy}
          className="mt-3 min-h-11 rounded-xl border border-pf-light px-4 text-sm font-semibold"
        >
          Load more cases
        </button>
      ) : null}
      <label className="mt-5 block text-sm font-semibold text-pf-deep">
        Evaluation target
        <select
          aria-label="Evaluation target"
          value={approvedPackageId}
          onChange={(event) => {
            setApprovedPackageId(event.target.value)
            setSourceCoverage(null)
          }}
          disabled={busy}
          className="mt-2 block min-h-11 w-full max-w-xl rounded-xl border border-pf-light bg-white px-3"
        >
          <option value="">Current live venue content</option>
          {(props.approvedPackages ?? []).map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              Approved onboarding package · {pkg.payloadHash.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-pf-deep/55">
        Onboarding QA should target the exact approved package. Live content is retained for legacy
        operational evaluations.
      </p>
      <button
        type="button"
        onClick={previewSourceCoverage}
        disabled={busy || selected.size === 0 || Boolean(approvedPackageId)}
        className="mt-3 min-h-11 rounded-xl border border-pf-light px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
      >
        Check current source coverage
      </button>
      <p className="mt-2 text-xs text-pf-deep/55">
        Provider-free lexical evidence for the current live content only. It does not judge semantic
        support, set a threshold, pass a case, or approve a release.
      </p>
      {sourceCoverage ? (
        <section
          className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
          aria-live="polite"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
            Live source version {sourceCoverage.contentVersion} ·{' '}
            {sourceCoverage.contentSnapshotHash.slice(0, 12)}
          </p>
          <ul className="mt-2 space-y-2 text-sm text-slate-900">
            {sourceCoverage.cases.map((item) => (
              <li key={item.caseId}>
                <span className="font-semibold">{item.caseKey}</span>:{' '}
                {item.coverage.supportedMarkers}/{item.coverage.totalMarkers} lexical markers found
                {item.coverage.markers.some((marker) => !marker.supported) ? (
                  <span className="block text-xs text-amber-900">
                    Not found:{' '}
                    {item.coverage.markers
                      .filter((marker) => !marker.supported)
                      .map((marker) => marker.markerId)
                      .join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <label className="mt-5 block text-sm font-semibold text-pf-deep">
        Budget ceiling (USD, maximum $1)
        <input
          aria-label="Budget ceiling"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          disabled={busy || !props.runnerEnabled}
          inputMode="decimal"
          className="mt-2 block min-h-11 w-full max-w-xs rounded-xl border border-pf-light px-3"
        />
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={busy || !props.runnerEnabled || selected.size === 0}
        className="mt-4 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Requesting…' : 'Request run'}
      </button>
      {message ? (
        <p role="status" className="mt-3 text-sm text-pf-deep/75">
          {message}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-pf-deep/55">
        A request freezes identities and queues evaluation work only. It does not publish or change
        venue content.
      </p>
    </section>
  )
}
