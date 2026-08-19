'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Verdict = 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'INCONCLUSIVE'

export function AgentOutcomeObservationForm({
  tenantId,
  venueId,
  agentRunId,
}: {
  tenantId: string
  venueId: string
  agentRunId: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const operationId = useRef<string | null>(null)
  const [verdict, setVerdict] = useState<Verdict>('POSITIVE')
  const [summary, setSummary] = useState('')
  const [evidenceRef, setEvidenceRef] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedSummary = summary.trim()
    if (!normalizedSummary || active.current) return
    active.current = true
    setPending(true)
    setFeedback(null)
    operationId.current ??= crypto.randomUUID()
    try {
      await client.admin.recordAgentRunOutcome.mutate({
        operationId: operationId.current,
        tenantId,
        venueId,
        agentRunId,
        verdict,
        summary: normalizedSummary,
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      })
      operationId.current = null
      setSummary('')
      setEvidenceRef('')
      setFeedback('Outcome evidence recorded. Run status and execution authority were unchanged.')
      router.refresh()
    } catch {
      setFeedback(
        'The outcome could not be confirmed. Retry preserves the same operation identity.',
      )
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="rounded-3xl border border-emerald-200 bg-emerald-50/40 p-5"
      aria-busy={pending}
    >
      <h3 className="text-xl font-semibold text-pf-deep">Record the outcome</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        Record whether this work was actually useful. Completion alone is never treated as quality,
        and this observation does not grant approval or restart work.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[14rem_1fr]">
        <label className="grid content-start gap-2 text-sm font-semibold text-pf-deep">
          Verdict
          <select
            value={verdict}
            disabled={pending}
            onChange={(event) => setVerdict(event.target.value as Verdict)}
            className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
          >
            <option value="POSITIVE">Useful as delivered</option>
            <option value="MIXED">Useful with corrections</option>
            <option value="NEGATIVE">Not useful / wrong</option>
            <option value="INCONCLUSIVE">Outcome not known yet</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm font-semibold text-pf-deep">
          What happened?
          <textarea
            rows={3}
            maxLength={2000}
            required
            disabled={pending}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            className="rounded-2xl border border-emerald-200 bg-white px-4 py-3 font-normal outline-none focus:border-pf-primary"
            placeholder="Describe the accepted result, correction, failure, or evidence still needed…"
          />
        </label>
      </div>
      <label className="mt-4 grid gap-2 text-sm font-semibold text-pf-deep">
        Evidence reference (optional)
        <input
          maxLength={500}
          disabled={pending}
          value={evidenceRef}
          onChange={(event) => setEvidenceRef(event.target.value)}
          className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal outline-none focus:border-pf-primary"
          placeholder="Artifact, decision, support case, report, or other stable reference"
        />
      </label>
      <button
        type="submit"
        disabled={pending || !summary.trim()}
        className="mt-4 min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? 'Recording…' : 'Record observation'}
      </button>
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
    </form>
  )
}
