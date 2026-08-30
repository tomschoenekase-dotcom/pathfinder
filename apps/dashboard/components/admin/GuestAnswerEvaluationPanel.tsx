'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export type GuestAnswerEvaluationRequest = {
  id: string
  guestChatTurnId: string
  answerHash: string
  evidenceSetHash: string
  status: 'STAGED' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'AMBIGUOUS'
  attemptNumber: number
  providerDispatchedAt: Date | null
  resultAttributionId: string | null
  lastErrorCode: string | null
  createdAt: Date
}

type Readiness = {
  processEnabled: boolean
  durableGlobalEnabled: boolean
  tenantEnabled: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function shortHash(value: string) {
  return value.slice(0, 12)
}

export function GuestAnswerEvaluationPanel(props: {
  tenantId: string
  venueId: string
  requests: GuestAnswerEvaluationRequest[]
  readiness: Readiness
  executionEnabled: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const operationId = useRef(crypto.randomUUID())
  const [turnId, setTurnId] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function prepare() {
    if (!UUID.test(turnId) || busyId) {
      setMessage('Enter the exact completed public guest-turn UUID.')
      return
    }
    setBusyId('prepare')
    setMessage(null)
    try {
      await client.admin.prepareGuestAnswerAttributionEvaluation.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        operationId: operationId.current,
        guestChatTurnId: turnId,
      })
      operationId.current = crypto.randomUUID()
      setTurnId('')
      setMessage('Exact answer and evidence staged. No provider work was started.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The evaluation request was not staged.')
    } finally {
      setBusyId(null)
    }
  }

  async function queue(requestId: string) {
    if (!props.executionEnabled || busyId) return
    setBusyId(requestId)
    setMessage(null)
    try {
      await client.admin.queueGuestAnswerAttributionEvaluation.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        requestId,
      })
      setMessage('Semantic review queued under the current evaluation policy gates.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The evaluation request was not queued.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6"
      aria-labelledby="guest-answer-evaluator-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Answer evidence
          </p>
          <h3
            id="guest-answer-evaluator-heading"
            className="mt-1 text-xl font-semibold text-pf-deep"
          >
            Semantic claim review
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
            Stage one completed public answer by its exact turn ID. Provider review starts only
            after a separate queue action and all three evaluation gates pass. Results are internal
            descriptive evidence; they cannot publish, repair content, or authorize a release.
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            props.executionEnabled
              ? 'bg-emerald-100 text-emerald-900'
              : 'bg-slate-100 text-slate-700'
          }`}
        >
          {props.executionEnabled ? 'Execution enabled' : 'Execution default-off'}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="text-sm font-semibold text-pf-deep">
          Completed public guest-turn UUID
          <input
            value={turnId}
            onChange={(event) => setTurnId(event.target.value.trim())}
            placeholder="00000000-0000-4000-8000-000000000000"
            autoComplete="off"
            className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 font-mono text-sm text-pf-deep outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          />
        </label>
        <button
          type="button"
          onClick={() => void prepare()}
          disabled={busyId !== null}
          className="min-h-11 self-end rounded-xl bg-pf-deep px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyId === 'prepare' ? 'Staging…' : 'Stage exact evidence'}
        </button>
      </div>

      <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
        {[
          ['API process', props.readiness.processEnabled],
          ['Global policy', props.readiness.durableGlobalEnabled],
          ['Tenant policy', props.readiness.tenantEnabled],
        ].map(([label, enabled]) => (
          <div key={String(label)} className="rounded-xl bg-pf-surface px-3 py-2">
            <dt className="font-semibold text-pf-deep/75">{label}</dt>
            <dd className="mt-1 font-semibold text-pf-deep">{enabled ? 'Enabled' : 'Off'}</dd>
          </div>
        ))}
      </dl>

      {message ? (
        <p className="mt-4 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-950" role="status">
          {message}
        </p>
      ) : null}

      {props.requests.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-pf-light p-5 text-sm text-pf-deep/65">
          No machine-review requests exist for this venue. Opening this page never stages or queues
          one.
        </p>
      ) : (
        <ul className="mt-5 space-y-3" aria-label="Guest answer semantic review requests">
          {props.requests.map((request) => (
            <li key={request.id} className="rounded-2xl border border-pf-light p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-pf-deep/75">
                    Turn {request.guestChatTurnId}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-pf-deep">
                    {request.status} · attempt {request.attemptNumber}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-pf-deep/75">
                    answer {shortHash(request.answerHash)} · evidence{' '}
                    {shortHash(request.evidenceSetHash)}
                  </p>
                  {request.lastErrorCode ? (
                    <p className="mt-2 text-xs font-semibold text-rose-800">
                      {request.lastErrorCode}
                    </p>
                  ) : null}
                </div>
                {request.status === 'STAGED' ? (
                  <button
                    type="button"
                    onClick={() => void queue(request.id)}
                    disabled={!props.executionEnabled || busyId !== null}
                    className="min-h-11 shrink-0 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {busyId === request.id ? 'Queueing…' : 'Queue semantic review'}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
