'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const REQUEST_TIMEOUT_MS = 15_000

type FrozenInput = {
  operationId: string
  tenantId: string
  venueId: string
  proposalId: string
  expectedProposalUpdatedAt: string
  resolutionNote: string
}

type Props = {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  onRecorded: () => void
  onFrozenChange?: (frozen: boolean) => void
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function SemanticReviewedDeclineForm(props: Props) {
  const client = useTRPCClient()
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [recorded, setRecorded] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const submitting = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const frozen = useRef<FrozenInput | null>(null)
  const scope = JSON.stringify([
    props.tenantId,
    props.venueId,
    props.proposalId,
    new Date(props.proposalUpdatedAt).toISOString(),
  ])
  const currentScope = useRef(scope)
  currentScope.current = scope

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      submitting.current = false
      props.onFrozenChange?.(false)
    }
  }, [])

  useEffect(() => {
    generation.current += 1
    controller.current?.abort()
    controller.current = null
    submitting.current = false
    frozen.current = null
    props.onFrozenChange?.(false)
    setNote('')
    setConfirmed(false)
    setPending(false)
    setUnknown(false)
    setRecorded(false)
    setFeedback(null)
  }, [scope])

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (submitting.current || recorded) return
    let input = frozen.current
    if (!input) {
      if (!confirmed || !note.trim()) return
      input = {
        operationId: crypto.randomUUID(),
        tenantId: props.tenantId,
        venueId: props.venueId,
        proposalId: props.proposalId,
        expectedProposalUpdatedAt: new Date(props.proposalUpdatedAt).toISOString(),
        resolutionNote: note.trim(),
      }
      frozen.current = input
      props.onFrozenChange?.(true)
    }
    submitting.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const requestController = new AbortController()
    controller.current = requestController
    setPending(true)
    setFeedback(null)
    try {
      await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        request: (signal) => client.admin.recordSupportReviewedDecline.mutate(input, { signal }),
      })
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      frozen.current = null
      setUnknown(false)
      setRecorded(true)
      setFeedback('Reviewed decline recorded. No venue content or support fulfillment was changed.')
      props.onRecorded()
    } catch (error) {
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      const code = errorCode(error)
      if (code === 'CONFLICT' || code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') {
        frozen.current = null
        setUnknown(false)
        props.onFrozenChange?.(false)
        setFeedback('The proposal changed. Refresh before recording another decision.')
      } else {
        setUnknown(true)
        setFeedback('The outcome is unknown. Retry the exact same decline to check it safely.')
      }
    } finally {
      if (controller.current === requestController) controller.current = null
      if (
        mounted.current &&
        generation.current === startedGeneration &&
        currentScope.current === startedScope
      )
        setPending(false)
      if (generation.current === startedGeneration) submitting.current = false
    }
  }

  if (recorded)
    return (
      <div className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">Reviewed decline recorded</p>
        <p className="mt-1">No venue content or support fulfillment was changed.</p>
      </div>
    )

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 border-t border-slate-200 pt-4">
      <fieldset disabled={pending || unknown}>
        <legend className="text-sm font-semibold text-slate-900">Record reviewed decline</legend>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Decline this support-backed proposal after reviewing its evidence. This does not change
          venue guidance or complete the support request.
        </p>
        <label className="mt-3 block text-sm font-medium text-slate-800">
          Decline review note
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          />
        </label>
        <label className="mt-3 flex min-h-11 items-start gap-3 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm this proposal should be declined after evidence review.
        </label>
        <button
          type="submit"
          disabled={!confirmed || !note.trim()}
          className="mt-3 min-h-11 rounded-lg border border-rose-300 px-4 text-sm font-semibold text-rose-800 disabled:opacity-50"
        >
          {pending ? 'Recording reviewed decline…' : 'Record reviewed decline'}
        </button>
      </fieldset>
      {unknown ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="mt-3 min-h-11 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-950"
        >
          {pending ? 'Checking reviewed decline…' : 'Retry exact reviewed decline'}
        </button>
      ) : null}
      {feedback ? (
        <p className="mt-3 text-sm text-slate-700" role="status">
          {feedback}
        </p>
      ) : null}
    </form>
  )
}
