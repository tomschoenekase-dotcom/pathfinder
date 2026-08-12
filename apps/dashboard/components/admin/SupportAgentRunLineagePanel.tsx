'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export type SupportRunLineage = {
  id: string
  requestVersion: number
  agentRunId: string
  linkedRunStatus: string
  linkedRunCompletedAt: Date
  createdAt: Date
  agentRun: {
    id: string
    runType: string
    requestedOperation: string
    agentIdentityId: string
    createdAt: Date
    completedAt: Date | null
  }
}

export function SupportAgentRunLineagePanel({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  lineages,
  nextCursor = null,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  lineages: SupportRunLineage[]
  nextCursor?: { createdAt: string; id: string } | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const scope = `${tenantId}:${venueId}:${requestId}:${expectedVersion}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [runState, setRunState] = useState({ scope, value: '' })
  const runId = runState.scope === scope ? runState.value : ''
  const operation = useRef({ scope, key: '', id: crypto.randomUUID() })
  const inFlight = useRef(false)
  const [pendingScope, setPendingScope] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ scope: string; failed: boolean; text: string } | null>(
    null,
  )
  const pending = pendingScope === scope
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null)
  const confirmed = confirmedScope === scope

  function change(value: string) {
    setRunState({ scope, value })
    operation.current = { scope, key: value, id: crypto.randomUUID() }
    setFeedback(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const exactRunId = runId.trim()
    if (!exactRunId || inFlight.current || confirmed) return
    inFlight.current = true
    setPendingScope(scope)
    setFeedback(null)
    if (operation.current.scope !== scope || operation.current.key !== exactRunId)
      operation.current = { scope, key: exactRunId, id: crypto.randomUUID() }
    try {
      await client.admin.linkSupportAgentRun.mutate({
        operationId: operation.current.id,
        tenantId,
        venueId,
        requestId,
        agentRunId: exactRunId,
        expectedVersion,
      })
      if (scopeRef.current !== scope) return
      setFeedback({
        scope,
        failed: false,
        text: 'Terminal run evidence linked. This did not create, start, resume, cancel, approve, or execute a run.',
      })
      setConfirmedScope(scope)
      router.refresh()
    } catch (error) {
      if (scopeRef.current !== scope) return
      const code = (error as { data?: { code?: unknown } } | null)?.data?.code
      setFeedback({
        scope,
        failed: true,
        text:
          code === 'CONFLICT'
            ? 'The request or run evidence changed. The run ID is retained; refresh before retrying.'
            : 'The link outcome could not be confirmed. The run ID and retry identity are retained.',
      })
    } finally {
      if (scopeRef.current === scope) {
        inFlight.current = false
        setPendingScope(null)
      }
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="support-run-lineage-heading">
      <div>
        <h3 id="support-run-lineage-heading" className="text-xl font-semibold text-pf-deep">
          Linked terminal runs
        </h3>
        <p className="mt-1 text-sm text-pf-deep/65">
          Immutable association evidence only. Linking never changes this request or controls a run.
        </p>
      </div>
      <form
        onSubmit={(event) => void submit(event)}
        className="rounded-2xl border border-pf-light bg-white p-4"
      >
        <label className="grid gap-2 text-sm font-semibold text-pf-deep">
          Existing terminal run ID
          <input
            required
            maxLength={191}
            value={runId}
            disabled={pending || confirmed}
            onChange={(event) => change(event.target.value)}
            className="min-h-11 rounded-xl border border-pf-light px-3 font-mono font-normal"
          />
        </label>
        <button
          type="submit"
          disabled={pending || confirmed || !runId.trim()}
          className="mt-3 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
        >
          {pending ? 'Linking…' : 'Link terminal run evidence'}
        </button>
        {feedback?.scope === scope ? (
          <p role={feedback.failed ? 'alert' : 'status'} className="mt-3 text-sm text-pf-deep/70">
            {feedback.text}
          </p>
        ) : null}
      </form>
      {lineages.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-pf-light p-4 text-sm text-pf-deep/65">
          No terminal run evidence is linked.
        </p>
      ) : (
        <ol className="space-y-3">
          {lineages.map((lineage) => (
            <li key={lineage.id} className="rounded-2xl border border-pf-light bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/admin/clients/${tenantId}/venues/${venueId}/agents/runs/${lineage.agentRunId}`}
                  className="font-semibold text-pf-primary"
                >
                  View terminal run
                </Link>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-800">
                  {lineage.linkedRunStatus}
                </span>
              </div>
              <p className="mt-2 text-sm text-pf-deep/70">
                {lineage.agentRun.requestedOperation} ·{' '}
                {lineage.agentRun.runType.replace(/_/g, ' ')}
              </p>
              <p className="mt-2 text-xs text-pf-deep/55">
                Linked to request version {lineage.requestVersion} · terminal snapshot{' '}
                {lineage.linkedRunCompletedAt.toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
      )}
      {nextCursor ? (
        <Link
          href={`/admin/clients/${tenantId}/venues/${venueId}/support-operations?requestId=${encodeURIComponent(requestId)}&lineageCursorCreatedAt=${encodeURIComponent(nextCursor.createdAt)}&lineageCursorId=${encodeURIComponent(nextCursor.id)}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-pf-primary"
        >
          Older linked run evidence
        </Link>
      ) : null}
    </section>
  )
}
