'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const RESOLUTION_TIMEOUT_MS = 15_000

type Desired = { title: string; category: string; content: string; isEnabled: boolean }
type FrozenInput = {
  operationId: string
  tenantId: string
  venueId: string
  proposalId: string
  expectedProposalUpdatedAt: string
  expectedPreviewHash: string
  relation: 'NEW_FACT' | 'CORRECTS' | 'SUPERSEDES'
  desired: Desired
  resolutionNote: string
}

type Props = {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  previewHash: string
  relation: FrozenInput['relation']
  desired: Desired
  onResolved: () => void
  onRefresh: () => void
  onFrozenChange?: (frozen: boolean) => void
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function SemanticDuplicateResolutionForm(props: Props) {
  const client = useTRPCClient()
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [unknown, setUnknown] = useState(false)
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
    props.previewHash,
    props.relation,
    props.desired,
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
    setFeedback(null)
  }, [scope])

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (submitting.current) return
    let input = frozen.current
    if (!input) {
      if (!confirmed || !note.trim()) return
      input = {
        operationId: crypto.randomUUID(),
        tenantId: props.tenantId,
        venueId: props.venueId,
        proposalId: props.proposalId,
        expectedProposalUpdatedAt: new Date(props.proposalUpdatedAt).toISOString(),
        expectedPreviewHash: props.previewHash,
        relation: props.relation,
        desired: { ...props.desired },
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
        timeoutMs: RESOLUTION_TIMEOUT_MS,
        request: (signal) => client.admin.resolveSupportSemanticDuplicate.mutate(input, { signal }),
      })
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      frozen.current = null
      props.onFrozenChange?.(false)
      setUnknown(false)
      setFeedback('Duplicate review recorded. No venue content was changed.')
      props.onResolved()
    } catch (error) {
      if (
        !mounted.current ||
        generation.current !== startedGeneration ||
        currentScope.current !== startedScope
      )
        return
      const code = errorCode(error)
      if (code === 'CONFLICT' || code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') {
        setUnknown(false)
        setFeedback('The proposal or preview changed. Refresh before reviewing it again.')
      } else {
        setUnknown(true)
        setFeedback('The outcome is unknown. Retry the exact same review to check it safely.')
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

  return (
    <form onSubmit={(event) => void submit(event)} className="border-t border-pf-light pt-5">
      <fieldset disabled={pending || unknown}>
        <legend className="text-sm font-semibold text-pf-deep">Review duplicate guidance</legend>
        <p className="mt-2 text-sm leading-6 text-pf-deep/70">
          Record that this approved proposal adds no new venue guidance. This records review history
          only and does not change or approve canonical content.
        </p>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Review note
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
          />
        </label>
        <label className="mt-3 flex min-h-11 items-start gap-3 text-sm text-pf-deep">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          I confirm the proposal duplicates the current guidance.
        </label>
        <button
          type="submit"
          disabled={!confirmed || !note.trim()}
          className="mt-3 min-h-11 rounded-lg bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Recording duplicate review…' : 'Record duplicate review'}
        </button>
      </fieldset>
      {unknown ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="mt-3 min-h-11 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-950"
        >
          {pending ? 'Checking duplicate review…' : 'Retry exact duplicate review'}
        </button>
      ) : null}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep" role="status">
          {feedback}
        </p>
      ) : null}
      {feedback?.startsWith('The proposal') ? (
        <button
          type="button"
          onClick={props.onRefresh}
          className="mt-3 min-h-11 text-sm font-semibold text-pf-primary underline underline-offset-4"
        >
          Refresh duplicate preview
        </button>
      ) : null}
    </form>
  )
}
