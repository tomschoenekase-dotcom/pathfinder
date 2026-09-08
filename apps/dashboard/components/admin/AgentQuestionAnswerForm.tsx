'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  tenantId: string
  venueId: string
  questionId: string
  expectedUpdatedAt: Date
  choices: string[]
  recipients: Array<{
    userId: string
    role: string
    user: { fullName: string | null; email: string }
  }>
  canRouteToClient: boolean
}

type AnswerPayload = {
  tenantId: string
  venueId: string
  questionId: string
  expectedUpdatedAt: string
  outcome: 'ANSWERED' | 'DISMISSED'
  answer: string
}

export function AgentQuestionAnswerForm({
  tenantId,
  venueId,
  questionId,
  expectedUpdatedAt,
  choices,
  recipients,
  canRouteToClient,
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [answer, setAnswer] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [unconfirmedWakeup, setUnconfirmedWakeup] = useState<{
    scope: string
    payload: AnswerPayload
  } | null>(null)
  const [recipientUserId, setRecipientUserId] = useState(recipients[0]?.userId ?? '')
  const [why, setWhy] = useState(
    'We need the venue’s authoritative answer before setup can continue.',
  )
  const [effect, setEffect] = useState(
    'Your response will answer this exact question and allow the blocked onboarding run to resume.',
  )
  const scope = JSON.stringify([tenantId, venueId, questionId, expectedUpdatedAt.toISOString()])
  const renderedScope = useRef(scope)
  const generation = useRef(0)
  if (renderedScope.current !== scope) {
    renderedScope.current = scope
    generation.current += 1
  }
  const retryWakeup = unconfirmedWakeup?.scope === scope ? unconfirmedWakeup : null

  useEffect(() => {
    setAnswer('')
    setFeedback(null)
    setUnconfirmedWakeup(null)
    setPending(false)
    active.current = false
  }, [scope])

  async function submit(outcome: 'ANSWERED' | 'DISMISSED') {
    const value = retryWakeup?.payload.answer ?? answer.trim()
    if (!value || active.current) return
    const payload: AnswerPayload = retryWakeup?.payload ?? {
      tenantId,
      venueId,
      questionId,
      expectedUpdatedAt: expectedUpdatedAt.toISOString(),
      outcome,
      answer: value,
    }
    const requestScope = scope
    const requestGeneration = generation.current
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.answerAgentQuestion.mutate(payload)
      if (generation.current !== requestGeneration) return
      const dispatchStatus = result.dispatchStatus
      if (dispatchStatus === 'UNCONFIRMED') {
        setUnconfirmedWakeup({ scope: requestScope, payload })
        setFeedback(
          'Answer recorded, but worker wake-up could not be confirmed. Retry the same wake-up; no action was approved.',
        )
        return
      }
      setUnconfirmedWakeup(null)
      setFeedback(
        dispatchStatus === 'ENQUEUED'
          ? 'Answer recorded. The run was queued for its worker to resume. This answer did not approve an action.'
          : result.runEligibleToResume
            ? 'Answer recorded. The run is eligible to resume when worker dispatch is available. This answer did not approve an action.'
            : 'Response recorded. No run resumed and no action was approved.',
      )
      router.refresh()
    } catch {
      if (generation.current !== requestGeneration) return
      setFeedback(
        retryWakeup
          ? 'The answer is already recorded, but worker wake-up is still unconfirmed. Retry the same wake-up.'
          : 'The response could not be confirmed. Refresh before retrying.',
      )
    } finally {
      if (generation.current === requestGeneration) {
        active.current = false
        setPending(false)
      }
    }
  }

  async function routeToClient() {
    if (!recipientUserId || !why.trim() || !effect.trim() || active.current || retryWakeup) return
    const requestGeneration = generation.current
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.routeAgentQuestionToClient.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        questionId,
        expectedUpdatedAt: expectedUpdatedAt.toISOString(),
        recipientUserId,
        category: 'GENERAL',
        subject: 'Torchiko needs your input to continue setup',
        why: why.trim(),
        effect: effect.trim(),
      })
      if (generation.current !== requestGeneration) return
      if (result.approvalGranted !== false) throw new Error('Unexpected approval state')
      setFeedback('Question sent to the selected venue contact. No approval was granted.')
      router.refresh()
    } catch {
      if (generation.current !== requestGeneration) return
      setFeedback('The question could not be routed. Refresh before retrying.')
    } finally {
      if (generation.current === requestGeneration) {
        active.current = false
        setPending(false)
      }
    }
  }

  return (
    <form className="mt-4" aria-busy={pending}>
      {choices.length ? (
        <div className="mb-3 flex flex-wrap gap-2" aria-label="Suggested answers">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={pending || Boolean(retryWakeup)}
              onClick={() => setAnswer(choice)}
              className="min-h-10 rounded-full border border-sky-200 bg-white px-4 text-sm font-semibold text-sky-950"
            >
              {choice}
            </button>
          ))}
        </div>
      ) : null}
      <label className="grid gap-2 text-sm font-semibold text-pf-deep">
        Your answer
        <textarea
          rows={3}
          maxLength={5000}
          required
          disabled={pending || Boolean(retryWakeup)}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          className="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-normal outline-none focus:border-pf-primary"
          placeholder="Give the agent the missing decision or context…"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || Boolean(retryWakeup) || !answer.trim()}
          onClick={() => void submit('ANSWERED')}
          className="min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Recording…' : 'Answer agent'}
        </button>
        <button
          type="button"
          disabled={pending || Boolean(retryWakeup) || !answer.trim()}
          onClick={() => void submit('DISMISSED')}
          className="min-h-11 rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-deep disabled:opacity-50"
        >
          Dismiss with note
        </button>
      </div>
      {retryWakeup ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit(retryWakeup.payload.outcome)}
          className="mt-3 min-h-11 rounded-2xl border border-pf-primary bg-white px-5 text-sm font-semibold text-pf-primary disabled:opacity-50"
        >
          {pending ? 'Retrying…' : 'Retry worker wake-up'}
        </button>
      ) : null}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
      {canRouteToClient ? (
        <details className="mt-4 rounded-2xl border border-sky-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-pf-deep">
            Ask a venue contact
          </summary>
          {recipients.length ? (
            <div className="mt-4 grid gap-3">
              <label className="grid gap-2 text-sm font-semibold text-pf-deep">
                Recipient
                <select
                  value={recipientUserId}
                  disabled={pending || Boolean(retryWakeup)}
                  onChange={(event) => setRecipientUserId(event.target.value)}
                  className="min-h-11 rounded-2xl border border-sky-200 bg-white px-4 font-normal"
                >
                  {recipients.map((recipient) => (
                    <option key={recipient.userId} value={recipient.userId}>
                      {recipient.user.fullName || recipient.user.email} (
                      {recipient.role.toLowerCase()})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-pf-deep">
                Why Torchiko is asking
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={why}
                  disabled={pending || Boolean(retryWakeup)}
                  onChange={(event) => setWhy(event.target.value)}
                  className="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-normal"
                />
              </label>
              <label className="grid gap-2 text-sm font-semibold text-pf-deep">
                What their answer changes
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={effect}
                  disabled={pending || Boolean(retryWakeup)}
                  onChange={(event) => setEffect(event.target.value)}
                  className="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-normal"
                />
              </label>
              <button
                type="button"
                disabled={
                  pending ||
                  Boolean(retryWakeup) ||
                  !recipientUserId ||
                  !why.trim() ||
                  !effect.trim()
                }
                onClick={() => void routeToClient()}
                className="min-h-11 justify-self-start rounded-2xl border border-pf-primary bg-white px-5 text-sm font-semibold text-pf-primary disabled:opacity-50"
              >
                {pending ? 'Sending…' : 'Send client question'}
              </button>
              <p className="text-xs leading-5 text-pf-deep/60">
                This opens a scoped support conversation. It does not approve or publish anything.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/60">
              No active venue contacts are available for this client.
            </p>
          )}
        </details>
      ) : null}
    </form>
  )
}
