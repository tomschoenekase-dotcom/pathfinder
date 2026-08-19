'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

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
  const [recipientUserId, setRecipientUserId] = useState(recipients[0]?.userId ?? '')
  const [why, setWhy] = useState(
    'We need the venue’s authoritative answer before setup can continue.',
  )
  const [effect, setEffect] = useState(
    'Your response will answer this exact question and allow the blocked onboarding run to resume.',
  )

  async function submit(outcome: 'ANSWERED' | 'DISMISSED') {
    const value = answer.trim()
    if (!value || active.current) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.answerAgentQuestion.mutate({
        tenantId,
        venueId,
        questionId,
        expectedUpdatedAt: expectedUpdatedAt.toISOString(),
        outcome,
        answer: value,
      })
      if (result.executionTriggered !== false) throw new Error('Unexpected execution state')
      setFeedback(
        result.runEligibleToResume
          ? 'Answer recorded. The run is eligible for its worker to resume.'
          : 'Response recorded. No action was executed.',
      )
      router.refresh()
    } catch {
      setFeedback('The response could not be confirmed. Refresh before retrying.')
    } finally {
      active.current = false
      setPending(false)
    }
  }

  async function routeToClient() {
    if (!recipientUserId || !why.trim() || !effect.trim() || active.current) return
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
      if (result.approvalGranted !== false) throw new Error('Unexpected approval state')
      setFeedback('Question sent to the selected venue contact. No approval was granted.')
      router.refresh()
    } catch {
      setFeedback('The question could not be routed. Refresh before retrying.')
    } finally {
      active.current = false
      setPending(false)
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
              disabled={pending}
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
          disabled={pending}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          className="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-normal outline-none focus:border-pf-primary"
          placeholder="Give the agent the missing decision or context…"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !answer.trim()}
          onClick={() => void submit('ANSWERED')}
          className="min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Recording…' : 'Answer agent'}
        </button>
        <button
          type="button"
          disabled={pending || !answer.trim()}
          onClick={() => void submit('DISMISSED')}
          className="min-h-11 rounded-2xl border border-pf-light bg-white px-5 text-sm font-semibold text-pf-deep disabled:opacity-50"
        >
          Dismiss with note
        </button>
      </div>
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
                  disabled={pending}
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
                  disabled={pending}
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
                  disabled={pending}
                  onChange={(event) => setEffect(event.target.value)}
                  className="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-normal"
                />
              </label>
              <button
                type="button"
                disabled={pending || !recipientUserId || !why.trim() || !effect.trim()}
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
