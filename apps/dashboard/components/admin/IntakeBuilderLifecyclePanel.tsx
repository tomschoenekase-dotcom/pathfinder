'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

export type IntakeBuilderLifecycle =
  inferRouterOutputs<AppRouter>['admin']['getIntakeBuilderLifecycle']
type Lifecycle = IntakeBuilderLifecycle
type Stage = Lifecycle['stages'][number]

const stateStyles: Record<Stage['state'], string> = {
  COMPLETE: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  CURRENT: 'border-sky-200 bg-sky-50 text-sky-950',
  BLOCKED: 'border-amber-300 bg-amber-50 text-amber-950',
  PENDING: 'border-slate-200 bg-slate-50 text-slate-500',
  SKIPPED: 'border-slate-200 bg-white text-slate-500',
}

function stageLabel(stage: Stage['stage']) {
  return stage.charAt(0) + stage.slice(1).toLowerCase()
}

export function IntakeBuilderLifecyclePanel({
  tenantId,
  venueId,
  runId,
}: {
  tenantId: string
  venueId: string
  runId: string
}) {
  const client = useTRPCClient()
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [researchBusy, setResearchBusy] = useState(false)
  const [researchError, setResearchError] = useState<string | null>(null)
  const sequence = useRef(0)
  const researchOperationId = useRef<string | null>(null)

  useEffect(() => {
    sequence.current += 1
    setLifecycle(null)
    setError(null)
    setBusy(false)
    setResearchBusy(false)
    setResearchError(null)
    researchOperationId.current = null
  }, [runId, tenantId, venueId])

  async function load() {
    const request = ++sequence.current
    setBusy(true)
    setError(null)
    try {
      const result = await client.admin.getIntakeBuilderLifecycle.query({
        tenantId,
        venueId,
        runId,
      })
      if (request === sequence.current) setLifecycle(result)
    } catch (cause) {
      if (request === sequence.current) {
        setError(cause instanceof Error ? cause.message : 'Builder lifecycle is unavailable.')
      }
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }

  async function runWebsiteResearch() {
    if (!lifecycle || researchBusy) return
    const operationId = researchOperationId.current ?? crypto.randomUUID()
    researchOperationId.current = operationId
    setResearchBusy(true)
    setResearchError(null)
    try {
      await client.admin.executeWebsiteIntakeResearch.mutate({
        tenantId,
        venueId,
        runId,
        operationId,
        ...(lifecycle.websiteResearch?.receiptId
          ? { priorReceiptId: lifecycle.websiteResearch.receiptId }
          : {}),
      })
      researchOperationId.current = null
      await load()
    } catch (cause) {
      setResearchError(
        cause instanceof Error ? cause.message : 'Website research could not be retained.',
      )
    } finally {
      setResearchBusy(false)
    }
  }

  if (!lifecycle) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-medium text-pf-deep disabled:opacity-50"
        >
          {busy ? 'Checking Builder…' : error ? 'Retry Builder status' : 'Inspect Builder status'}
        </button>
        {error ? (
          <p className="mt-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <IntakeBuilderLifecycleView
      lifecycle={lifecycle}
      onRunWebsiteResearch={() => void runWebsiteResearch()}
      researchBusy={researchBusy}
      researchError={researchError}
    />
  )
}

export function IntakeBuilderLifecycleView({
  lifecycle,
  onRunWebsiteResearch,
  researchBusy = false,
  researchError = null,
}: {
  lifecycle: Lifecycle
  onRunWebsiteResearch?: () => void
  researchBusy?: boolean
  researchError?: string | null
}) {
  const active = lifecycle.stages.find(({ stage }) => stage === lifecycle.currentStage)!
  return (
    <section
      className="mt-4 rounded-xl border border-pf-light bg-slate-50 p-4"
      aria-label="Builder lifecycle"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
            Builder VNext
          </p>
          <h3 className="mt-1 font-semibold text-pf-deep">
            {stageLabel(lifecycle.currentStage)} · {lifecycle.currentState.toLowerCase()}
          </h3>
          <p className="mt-1 text-sm text-pf-deep/70">
            Next: {lifecycle.nextAction.replaceAll('_', ' ').toLowerCase()}
          </p>
        </div>
        <span className="rounded-full border border-pf-light bg-white px-3 py-1 text-xs font-medium text-pf-deep/70">
          {lifecycle.stages.filter(({ state }) => state === 'COMPLETE').length}/14 complete
        </span>
      </div>

      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {lifecycle.stages.map((stage) => (
          <li
            key={stage.stage}
            className={`rounded-lg border px-2 py-2 text-xs ${stateStyles[stage.state]}`}
            aria-current={stage.stage === lifecycle.currentStage ? 'step' : undefined}
          >
            <span className="block font-semibold">{stageLabel(stage.stage)}</span>
            <span className="mt-0.5 block opacity-75">{stage.state.toLowerCase()}</span>
          </li>
        ))}
      </ol>

      {active.blockers.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-white p-3" role="status">
          <p className="text-sm font-semibold text-amber-950">Current blockers</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {active.blockers.map((item) => (
              <li key={`${item.code}:${item.path}`}>{item.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {lifecycle.websiteResearch ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-slate-200 bg-white p-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-pf-deep/60">Attempt</dt>
            <dd className="font-semibold text-pf-deep">
              {lifecycle.websiteResearch.attemptCount}/4
            </dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Pages</dt>
            <dd className="font-semibold text-pf-deep">{lifecycle.websiteResearch.fetchedPages}</dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Downloaded</dt>
            <dd className="font-semibold text-pf-deep">
              {Math.ceil(lifecycle.websiteResearch.fetchedBytes / 1024).toLocaleString()} KB
            </dd>
          </div>
          <div>
            <dt className="text-xs text-pf-deep/60">Cost · time</dt>
            <dd className="font-semibold text-pf-deep">
              {lifecycle.websiteResearch.estimatedCostUnits} units ·{' '}
              {(lifecycle.websiteResearch.latencyMs / 1000).toFixed(1)}s
            </dd>
          </div>
        </dl>
      ) : null}

      {onRunWebsiteResearch &&
      (lifecycle.nextAction === 'RUN_WEBSITE_RESEARCH' ||
        lifecycle.nextAction === 'RETRY_WEBSITE_RESEARCH') ? (
        <div className="mt-4">
          <button
            type="button"
            disabled={researchBusy}
            onClick={onRunWebsiteResearch}
            className="min-h-11 rounded-full bg-pf-primary px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
          >
            {researchBusy
              ? 'Researching website…'
              : lifecycle.nextAction === 'RETRY_WEBSITE_RESEARCH'
                ? 'Retry bounded research'
                : 'Run bounded research'}
          </button>
          <p className="mt-2 text-xs text-pf-deep/60">
            Up to 5 pages, one link level, 20 cost units, and 30 seconds. Results stay review-only.
          </p>
        </div>
      ) : null}
      {researchError ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {researchError}
        </p>
      ) : null}

      <p className="mt-3 text-xs text-pf-deep/60">
        This view is evidence-derived. Approval, apply, and publication remain separate human
        actions.
      </p>
    </section>
  )
}
