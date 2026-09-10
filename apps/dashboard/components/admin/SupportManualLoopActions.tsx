'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'
import {
  SupportCompletionOutcome,
  type SupportCompletionOutcomeValue,
} from '../SupportCompletionOutcome'
import type { SupportRequestStatus } from '@pathfinder/contracts/support-workflow'

type Draft = {
  scope: string
  informationBody: string
  missingInformation: string
  completionBody: string
  completionConfirmed: boolean
}

function emptyDraft(scope: string): Draft {
  return {
    scope,
    informationBody: '',
    missingInformation: '',
    completionBody: '',
    completionConfirmed: false,
  }
}

function lines(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function errorCode(error: unknown) {
  const direct = (error as { data?: { code?: unknown } } | null)?.data?.code
  if (typeof direct === 'string') return direct
  const shaped = (error as { shape?: { data?: { code?: unknown } } } | null)?.shape?.data?.code
  return typeof shaped === 'string' ? shaped : null
}

export function SupportManualLoopActions({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  currentStatus,
  missingInformation,
  onConfirmed,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  currentStatus: SupportRequestStatus
  missingInformation: string[]
  onConfirmed?: () => void
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const scope = JSON.stringify([tenantId, venueId, requestId, expectedVersion])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [draftState, setDraftState] = useState(() => emptyDraft(scope))
  const draft = draftState.scope === scope ? draftState : emptyDraft(scope)
  const [pendingState, setPendingState] = useState<{
    scope: string
    kind: 'request' | 'complete'
  } | null>(null)
  const pending = pendingState?.scope === scope ? pendingState.kind : null
  const [feedbackState, setFeedbackState] = useState<{
    scope: string
    failed: boolean
    text: string
  } | null>(null)
  const feedback = feedbackState?.scope === scope ? feedbackState : null
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null)
  const confirmed = confirmedScope === scope
  const [conflictScope, setConflictScope] = useState<string | null>(null)
  const conflict = conflictScope === scope
  const requestInformationAllowed = currentStatus === 'OPEN' || currentStatus === 'IN_REVIEW'
  const completionAllowed = requestInformationAllowed && missingInformation.length === 0
  const inFlight = useRef<{ scope: string; generation: number } | null>(null)
  const generation = useRef(0)
  const requestAttempt = useRef({ scope, operationId: crypto.randomUUID() })
  const completionAttempt = useRef({ scope, operationId: crypto.randomUUID() })
  const [completionPreviewState, setCompletionPreviewState] = useState<{
    scope: string
    outcome: SupportCompletionOutcomeValue
    fulfillmentDigest: string
    expectedVersion: number
  } | null>(null)
  const completionPreview = completionPreviewState?.scope === scope ? completionPreviewState : null
  const [completionUnknownScope, setCompletionUnknownScope] = useState<string | null>(null)
  const completionUnknown = completionUnknownScope === scope
  const frozenCompletion = useRef<{
    scope: string
    input: {
      operationId: string
      tenantId: string
      venueId: string
      requestId: string
      expectedVersion: number
      body: string
      expectedCompletionOutcome: SupportCompletionOutcomeValue
      expectedFulfillmentDigest: string
    }
  } | null>(null)

  function updateDraft(change: (current: Draft) => Draft, rotate: 'request' | 'complete') {
    setDraftState((current) => change(current.scope === scope ? current : emptyDraft(scope)))
    const attempt = rotate === 'request' ? requestAttempt : completionAttempt
    attempt.current = { scope, operationId: crypto.randomUUID() }
    setFeedbackState(null)
    setConflictScope(null)
    if (rotate === 'complete') {
      setCompletionPreviewState(null)
      setCompletionUnknownScope(null)
      frozenCompletion.current = null
    }
  }

  function operationId(attempt: typeof requestAttempt) {
    if (attempt.current.scope !== scope) {
      attempt.current = { scope, operationId: crypto.randomUUID() }
    }
    return attempt.current.operationId
  }

  function begin(kind: 'request' | 'complete') {
    if (inFlight.current?.scope === scope || confirmed || conflict) return null
    const currentGeneration = ++generation.current
    inFlight.current = { scope, generation: currentGeneration }
    setPendingState({ scope, kind })
    setFeedbackState(null)
    return currentGeneration
  }

  function finish(currentGeneration: number) {
    if (
      scopeRef.current !== scope ||
      inFlight.current?.scope !== scope ||
      inFlight.current.generation !== currentGeneration
    )
      return false
    inFlight.current = null
    setPendingState(null)
    return true
  }

  function failure(error: unknown, noun: string) {
    const conflict = errorCode(error) === 'CONFLICT'
    if (conflict) setConflictScope(scope)
    setFeedbackState({
      scope,
      failed: true,
      text: conflict
        ? `This request changed before ${noun} was recorded. Your draft is retained; refresh before retrying.`
        : `We could not confirm whether ${noun} was recorded. Your draft and retry identity are retained.`,
    })
  }

  async function requestInformation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!requestInformationAllowed) return
    const items = lines(draft.missingInformation)
    if (items.length === 0 || items.length > 30 || items.some((item) => item.length > 500)) {
      setFeedbackState({
        scope,
        failed: true,
        text: 'Enter 1 to 30 specific questions, one per line and no more than 500 characters each.',
      })
      return
    }
    if (new Set(items).size !== items.length) {
      setFeedbackState({ scope, failed: true, text: 'Each requested detail must be unique.' })
      return
    }
    const currentGeneration = begin('request')
    if (currentGeneration === null) return
    try {
      await client.admin.requestSupportInformation.mutate({
        operationId: operationId(requestAttempt),
        tenantId,
        venueId,
        requestId,
        expectedVersion,
        body: draft.informationBody,
        missingInformation: items,
      })
      if (!finish(currentGeneration)) return
      requestAttempt.current = { scope, operationId: crypto.randomUUID() }
      setFeedbackState({
        scope,
        failed: false,
        text: 'The questions were sent and the request is now waiting for the client. No package work was run.',
      })
      setConfirmedScope(scope)
      onConfirmed?.()
      router.refresh()
    } catch (error) {
      if (!finish(currentGeneration)) return
      failure(error, 'the information request')
    }
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!completionAllowed || !draft.completionConfirmed || !completionPreview) return
    const currentGeneration = begin('complete')
    if (currentGeneration === null) return
    const input =
      frozenCompletion.current?.scope === scope
        ? frozenCompletion.current.input
        : {
            operationId: operationId(completionAttempt),
            tenantId,
            venueId,
            requestId,
            expectedVersion,
            body: draft.completionBody,
            expectedCompletionOutcome: completionPreview.outcome,
            expectedFulfillmentDigest: completionPreview.fulfillmentDigest,
          }
    frozenCompletion.current = { scope, input }
    try {
      await runBoundedClientRequest({
        parentSignal: new AbortController().signal,
        timeoutMs: 15_000,
        request: (signal) => client.admin.completeSupportRequest.mutate(input, { signal }),
      })
      if (!finish(currentGeneration)) return
      completionAttempt.current = { scope, operationId: crypto.randomUUID() }
      frozenCompletion.current = null
      setCompletionUnknownScope(null)
      setFeedbackState({
        scope,
        failed: false,
        text: 'The client was notified and this support request was completed. No package was approved, applied, or published.',
      })
      setConfirmedScope(scope)
      onConfirmed?.()
      router.refresh()
    } catch (error) {
      if (!finish(currentGeneration)) return
      if (errorCode(error) !== 'CONFLICT') setCompletionUnknownScope(scope)
      failure(error, 'manual completion')
    }
  }

  async function prepareCompletion() {
    const currentGeneration = begin('complete')
    if (currentGeneration === null) return
    try {
      const result = await runBoundedClientRequest({
        parentSignal: new AbortController().signal,
        timeoutMs: 15_000,
        request: (signal) =>
          client.admin.getSupportCompletionPreview.query(
            { tenantId, venueId, requestId, expectedVersion },
            { signal },
          ),
      })
      if (!finish(currentGeneration) || scopeRef.current !== scope) return
      setCompletionPreviewState({ scope, ...result })
      setFeedbackState(null)
    } catch (error) {
      if (!finish(currentGeneration)) return
      failure(error, 'the completion outcome review')
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
      aria-labelledby="manual-support-heading"
    >
      <h3 id="manual-support-heading" className="text-lg font-semibold text-pf-deep">
        Client follow-up
      </h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        Send exact questions or close the support conversation manually. These actions send a
        client-visible message and update support status only; they do not run package or deployment
        work.
      </p>

      {requestInformationAllowed ? (
        <form
          className="mt-5 space-y-4 border-t border-pf-light pt-5"
          onSubmit={(event) => void requestInformation(event)}
          aria-busy={pending === 'request'}
        >
          <h4 className="font-semibold text-pf-deep">Request information</h4>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Message to client
            <textarea
              required
              rows={4}
              maxLength={20_000}
              disabled={pending !== null || confirmed || conflict}
              value={draft.informationBody}
              onChange={(event) =>
                updateDraft(
                  (current) => ({ ...current, informationBody: event.target.value }),
                  'request',
                )
              }
              className="rounded-xl border border-pf-light px-3 py-2 font-normal"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Details needed
            <textarea
              required
              rows={4}
              maxLength={15_030}
              disabled={pending !== null || confirmed || conflict}
              value={draft.missingInformation}
              onChange={(event) =>
                updateDraft(
                  (current) => ({ ...current, missingInformation: event.target.value }),
                  'request',
                )
              }
              placeholder="One specific question per line"
              className="rounded-xl border border-pf-light px-3 py-2 font-normal"
            />
          </label>
          <button
            type="submit"
            disabled={pending !== null || confirmed || conflict}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending === 'request' ? 'Sending…' : 'Send questions'}
          </button>
        </form>
      ) : (
        <p className="mt-5 rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/70">
          Information can be requested only while this conversation is received or in review.
        </p>
      )}

      {completionAllowed ? (
        <form
          className="mt-6 space-y-4 border-t border-pf-light pt-5"
          onSubmit={(event) => void complete(event)}
          aria-busy={pending === 'complete'}
        >
          <h4 className="font-semibold text-pf-deep">Complete manually</h4>
          {!completionPreview ? (
            <button
              type="button"
              disabled={pending !== null || confirmed || conflict || completionUnknown}
              onClick={() => void prepareCompletion()}
              className="min-h-11 rounded-xl border border-pf-primary px-5 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              {pending === 'complete' ? 'Reviewing outcome…' : 'Review completion outcome'}
            </button>
          ) : (
            <div className="border-l-2 border-pf-primary pl-4">
              <SupportCompletionOutcome outcome={completionPreview.outcome} />
              <p className="mt-1 text-sm text-pf-deep/70">
                This outcome reflects the currently reviewed work for request version{' '}
                {completionPreview.expectedVersion}.
              </p>
            </div>
          )}
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Completion message to client
            <textarea
              required
              rows={4}
              maxLength={20_000}
              disabled={pending !== null || confirmed || conflict || completionUnknown}
              value={draft.completionBody}
              onChange={(event) =>
                updateDraft(
                  (current) => ({ ...current, completionBody: event.target.value }),
                  'complete',
                )
              }
              className="rounded-xl border border-pf-light px-3 py-2 font-normal"
            />
          </label>
          {completionPreview ? (
            <label className="flex items-start gap-2 text-sm text-pf-deep/75">
              <input
                type="checkbox"
                checked={draft.completionConfirmed}
                disabled={pending !== null || confirmed || conflict || completionUnknown}
                onChange={(event) =>
                  setDraftState((current) => ({
                    ...(current.scope === scope ? current : emptyDraft(scope)),
                    completionConfirmed: event.target.checked,
                  }))
                }
                className="mt-1"
              />
              I confirm this conversation is complete. This does not approve, apply, or publish
              package work.
            </label>
          ) : null}
          {completionPreview ? (
            <button
              type="submit"
              disabled={pending !== null || confirmed || conflict || !draft.completionConfirmed}
              className="min-h-11 rounded-xl border border-pf-primary px-5 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              {pending === 'complete'
                ? 'Completing…'
                : completionUnknown
                  ? 'Retry exact completion'
                  : 'Complete support request'}
            </button>
          ) : null}
        </form>
      ) : (
        <p className="mt-4 rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/70">
          {requestInformationAllowed
            ? 'Resolve the recorded information checklist before completing this request.'
            : 'Manual completion is available only while this conversation is received or in review.'}
        </p>
      )}

      {feedback ? (
        <p className="mt-4 text-sm text-pf-deep/70" role={feedback.failed ? 'alert' : 'status'}>
          {feedback.text}
        </p>
      ) : null}
      {conflict ? (
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-3 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary"
        >
          Refresh request
        </button>
      ) : null}
    </section>
  )
}
