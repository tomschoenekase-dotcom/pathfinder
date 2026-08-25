'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Verdict = 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'INCONCLUSIVE'
type EvidenceKind = 'HUMAN_REVIEW' | 'ROLLBACK' | 'POLICY_VIOLATION' | 'CONFIDENCE_CALIBRATION'

export function AgentOutcomeObservationForm({
  tenantId,
  venueId,
  agentRunId,
  actions = [],
}: {
  tenantId: string
  venueId: string
  agentRunId: string
  actions?: Array<{ id: string; actionName: string; status: string }>
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const operationId = useRef<string | null>(null)
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind>('HUMAN_REVIEW')
  const [verdict, setVerdict] = useState<Verdict>('POSITIVE')
  const [relatedAgentActionId, setRelatedAgentActionId] = useState('')
  const [policyCode, setPolicyCode] = useState('')
  const [severity, setSeverity] = useState<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>('MEDIUM')
  const [predictionRef, setPredictionRef] = useState('')
  const [predictedConfidencePercent, setPredictedConfidencePercent] = useState('')
  const [actualCorrect, setActualCorrect] = useState(true)
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
      const base = {
        operationId: operationId.current,
        tenantId,
        venueId,
        agentRunId,
        summary: normalizedSummary,
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      }
      if (evidenceKind === 'HUMAN_REVIEW') {
        await client.admin.recordAgentRunOutcome.mutate({ ...base, verdict })
      } else if (evidenceKind === 'ROLLBACK') {
        if (!relatedAgentActionId) throw new Error('A rolled-back action is required.')
        await client.admin.recordAgentTrustSignal.mutate({
          ...base,
          signalKind: evidenceKind,
          relatedAgentActionId,
        })
      } else if (evidenceKind === 'POLICY_VIOLATION') {
        if (!policyCode.trim()) throw new Error('A policy code is required.')
        await client.admin.recordAgentTrustSignal.mutate({
          ...base,
          signalKind: evidenceKind,
          ...(relatedAgentActionId ? { relatedAgentActionId } : {}),
          policyCode: policyCode.trim(),
          severity,
        })
      } else {
        const confidence = Number(predictedConfidencePercent)
        if (
          !predictionRef.trim() ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 100
        ) {
          throw new Error('A prediction reference and confidence from 0 to 100 are required.')
        }
        await client.admin.recordAgentTrustSignal.mutate({
          ...base,
          signalKind: evidenceKind,
          predictionRef: predictionRef.trim(),
          predictedConfidenceBps: Math.round(confidence * 100),
          actualCorrect,
        })
      }
      operationId.current = null
      setSummary('')
      setEvidenceRef('')
      setFeedback(
        'Outcome evidence recorded. Run status, routing, and execution authority were unchanged.',
      )
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
      <h3 className="text-xl font-semibold text-pf-deep">Record outcome and trust evidence</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        Record whether this work was actually useful. Completion alone is never treated as quality,
        and this observation does not grant approval or restart work.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-[14rem_1fr]">
        <label className="grid content-start gap-2 text-sm font-semibold text-pf-deep">
          Evidence type
          <select
            value={evidenceKind}
            disabled={pending}
            onChange={(event) => {
              operationId.current = null
              setEvidenceKind(event.target.value as EvidenceKind)
              setFeedback(null)
            }}
            className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
          >
            <option value="HUMAN_REVIEW">Quality / usefulness review</option>
            <option value="ROLLBACK">Action rollback</option>
            <option value="POLICY_VIOLATION">Policy violation</option>
            <option value="CONFIDENCE_CALIBRATION">Confidence calibration</option>
          </select>
        </label>
        <div className="hidden lg:block" aria-hidden="true" />
        {evidenceKind === 'HUMAN_REVIEW' ? (
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
        ) : null}
        {evidenceKind === 'ROLLBACK' || evidenceKind === 'POLICY_VIOLATION' ? (
          <label className="grid content-start gap-2 text-sm font-semibold text-pf-deep">
            Related action {evidenceKind === 'ROLLBACK' ? '(required)' : '(optional)'}
            <select
              value={relatedAgentActionId}
              required={evidenceKind === 'ROLLBACK'}
              disabled={pending}
              onChange={(event) => setRelatedAgentActionId(event.target.value)}
              className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
            >
              <option value="">{actions.length ? 'Select an action' : 'No action selected'}</option>
              {actions
                .filter((action) => evidenceKind !== 'ROLLBACK' || action.status === 'SUCCEEDED')
                .map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.actionName} · {action.status.replaceAll('_', ' ').toLowerCase()}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {evidenceKind === 'POLICY_VIOLATION' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-semibold text-pf-deep">
              Policy code
              <input
                required
                maxLength={191}
                disabled={pending}
                value={policyCode}
                onChange={(event) => setPolicyCode(event.target.value)}
                className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
                placeholder="customer-contact-without-approval"
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-pf-deep">
              Severity
              <select
                value={severity}
                disabled={pending}
                onChange={(event) =>
                  setSeverity(event.target.value as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL')
                }
                className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
          </div>
        ) : null}
        {evidenceKind === 'CONFIDENCE_CALIBRATION' ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="grid gap-2 text-sm font-semibold text-pf-deep">
              Prediction reference
              <input
                required
                maxLength={191}
                disabled={pending}
                value={predictionRef}
                onChange={(event) => setPredictionRef(event.target.value)}
                className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
                placeholder="answer-7"
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-pf-deep">
              Predicted confidence (%)
              <input
                type="number"
                required
                min={0}
                max={100}
                step="0.01"
                disabled={pending}
                value={predictedConfidencePercent}
                onChange={(event) => setPredictedConfidencePercent(event.target.value)}
                className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-pf-deep">
              Reviewed result
              <select
                value={actualCorrect ? 'correct' : 'incorrect'}
                disabled={pending}
                onChange={(event) => setActualCorrect(event.target.value === 'correct')}
                className="min-h-11 rounded-2xl border border-emerald-200 bg-white px-4 font-normal"
              >
                <option value="correct">Correct</option>
                <option value="incorrect">Incorrect</option>
              </select>
            </label>
          </div>
        ) : null}
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
        {pending ? 'Recording…' : 'Record evidence'}
      </button>
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
    </form>
  )
}
