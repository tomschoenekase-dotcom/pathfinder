'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export type EvaluationCaseListItem = {
  id: string
  caseKey: string
  revision: number
  category: string
  schemaVersion: string
  sourceType: string
  createdAt: Date
}
type Cursor = { createdAt: string; id: string }

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
  maximumCases: number
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [cases, setCases] = useState(props.initialCases)
  const [nextCursor, setNextCursor] = useState(props.initialNextCursor)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [budget, setBudget] = useState('0.25')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const idempotencyKey = useRef(crypto.randomUUID())
  const submitting = useRef(false)

  async function loadMore() {
    if (!nextCursor || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const page = await client.admin.listEvaluationCases.query({
        tenantId: props.tenantId,
        venueId: props.venueId,
        cursor: nextCursor,
      })
      setCases((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch {
      setMessage('More cases could not be loaded. Your current selections are preserved.')
    } finally {
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
    try {
      const result = await client.admin.requestEvaluationRun.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        idempotencyKey: idempotencyKey.current,
        caseIds: [...selected],
        budgetCeilingE8Usd,
      })
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
        setMessage('Run queued. Refreshing the evidence list…')
      } catch {
        setMessage(
          'Run queueing was confirmed, but refreshed evidence could not be loaded yet. Do not resubmit; refresh this page.',
        )
      }
      idempotencyKey.current = crypto.randomUUID()
      router.refresh()
    } catch {
      setMessage(
        'The request outcome is unknown. Your selections are preserved; refresh evaluation evidence before retrying with the same request.',
      )
    } finally {
      submitting.current = false
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
      {cases.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/65">
          No evaluation cases are ready for this venue.
        </p>
      ) : (
        <fieldset className="mt-4 space-y-2" disabled={busy || !props.runnerEnabled}>
          <legend className="text-sm font-semibold text-pf-deep">
            Cases ({selected.size}/{props.maximumCases})
          </legend>
          {cases.map((item) => (
            <label
              key={item.id}
              className="flex min-h-11 items-start gap-3 rounded-xl border border-pf-light p-3"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(item.id)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (event.target.checked && next.size < props.maximumCases) next.add(item.id)
                    else if (!event.target.checked) next.delete(item.id)
                    return next
                  })
                }
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
