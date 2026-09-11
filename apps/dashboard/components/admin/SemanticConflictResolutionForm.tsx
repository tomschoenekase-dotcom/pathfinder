'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const RESOLUTION_TIMEOUT_MS = 15_000

type Desired = { title: string; category: string; content: string; isEnabled: boolean }
type Outcome = 'KEEP_CANONICAL' | 'PROPOSE_REPLACEMENT'
type ResolutionResult = {
  replacementProposalId: string | null
  resolutionId: string
  outcome: string
}

type Props = {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  previewHash: string
  relation: 'CORRECTS' | 'SUPERSEDES'
  desired: Desired
  question: {
    id: string
    answer: string
    updatedAt: Date | string
    answeredAt: Date | string
    answerHash: string
  }
  onResolved: (result: ResolutionResult) => void
  onRefresh: () => void
  onFrozenChange?: (frozen: boolean) => void
}

type FrozenInput = {
  operationId: string
  tenantId: string
  venueId: string
  proposalId: string
  expectedProposalUpdatedAt: string
  expectedPreviewHash: string
  questionId: string
  expectedQuestionUpdatedAt: string
  expectedAnsweredAt: string
  expectedAnswerHash: string
  relation: 'CORRECTS' | 'SUPERSEDES'
  desired: Desired
  replacementDesired?: Desired
  outcome: Outcome
  resolutionNote: string
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

const iso = (value: Date | string) => new Date(value).toISOString()

export function SemanticConflictResolutionForm(props: Props) {
  const client = useTRPCClient()
  const [outcome, setOutcome] = useState<Outcome | ''>('')
  const [replacement, setReplacement] = useState<Desired>(props.desired)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [unknown, setUnknown] = useState(false)
  const [frozenState, setFrozenState] = useState(false)
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
    iso(props.proposalUpdatedAt),
    props.previewHash,
    props.relation,
    props.desired,
    props.question.id,
    iso(props.question.updatedAt),
    iso(props.question.answeredAt),
    props.question.answerHash,
  ])

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
    setFrozenState(false)
    props.onFrozenChange?.(false)
    setOutcome('')
    setReplacement(props.desired)
    setNote('')
    setPending(false)
    setUnknown(false)
    setFeedback(null)
  }, [scope])

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (submitting.current) return
    let input = frozen.current
    if (!input) {
      if (!outcome || !note.trim()) return
      input = {
        operationId: crypto.randomUUID(),
        tenantId: props.tenantId,
        venueId: props.venueId,
        proposalId: props.proposalId,
        expectedProposalUpdatedAt: iso(props.proposalUpdatedAt),
        expectedPreviewHash: props.previewHash,
        questionId: props.question.id,
        expectedQuestionUpdatedAt: iso(props.question.updatedAt),
        expectedAnsweredAt: iso(props.question.answeredAt),
        expectedAnswerHash: props.question.answerHash,
        relation: props.relation,
        desired: { ...props.desired },
        ...(outcome === 'PROPOSE_REPLACEMENT' ? { replacementDesired: { ...replacement } } : {}),
        outcome,
        resolutionNote: note.trim(),
      }
      frozen.current = input
      setFrozenState(true)
      props.onFrozenChange?.(true)
    }
    submitting.current = true
    const startedGeneration = generation.current
    const requestController = new AbortController()
    controller.current = requestController
    setPending(true)
    setFeedback(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: requestController.signal,
        timeoutMs: RESOLUTION_TIMEOUT_MS,
        request: (signal) => client.admin.resolveSemanticConflict.mutate(input, { signal }),
      })
      if (!mounted.current || generation.current !== startedGeneration) return
      frozen.current = null
      setFrozenState(false)
      props.onFrozenChange?.(false)
      setUnknown(false)
      setFeedback(
        result.outcome === 'KEEP_CANONICAL'
          ? 'Current venue guidance kept. The conflict is recorded.'
          : 'Replacement recorded for separate human review.',
      )
      props.onResolved(result)
    } catch (error) {
      if (!mounted.current || generation.current !== startedGeneration) return
      const code = errorCode(error)
      if (code === 'CONFLICT' || code === 'NOT_FOUND' || code === 'PRECONDITION_FAILED') {
        setUnknown(false)
        setFeedback('The proposal or answered question changed. Refresh before deciding again.')
      } else {
        setUnknown(true)
        setFeedback('The outcome is unknown. Retry the exact same resolution to check it safely.')
      }
    } finally {
      if (controller.current === requestController) controller.current = null
      if (mounted.current && generation.current === startedGeneration) setPending(false)
      submitting.current = false
    }
  }

  const replacementValid =
    outcome !== 'PROPOSE_REPLACEMENT' ||
    Boolean(replacement.title.trim() && replacement.category.trim() && replacement.content.trim())

  return (
    <form onSubmit={(event) => void submit(event)} className="border-t border-pf-light pt-5">
      <fieldset disabled={pending || unknown || frozenState}>
        <legend className="text-sm font-semibold text-pf-deep">Resolve answered conflict</legend>
        <p className="mt-2 text-sm leading-6 text-pf-deep/70">
          Operator answer: <span className="font-medium text-pf-deep">{props.question.answer}</span>
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex min-h-11 items-start gap-3 border-l-2 border-pf-light px-3 py-2 text-sm text-pf-deep">
            <input
              type="radio"
              name={`semantic-resolution-${props.question.id}`}
              checked={outcome === 'KEEP_CANONICAL'}
              onChange={() => setOutcome('KEEP_CANONICAL')}
            />
            <span>
              <strong className="block">Keep current guidance</strong>Record the answer without
              creating replacement content.
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-3 border-l-2 border-pf-light px-3 py-2 text-sm text-pf-deep">
            <input
              type="radio"
              name={`semantic-resolution-${props.question.id}`}
              checked={outcome === 'PROPOSE_REPLACEMENT'}
              onChange={() => setOutcome('PROPOSE_REPLACEMENT')}
            />
            <span>
              <strong className="block">Propose replacement</strong>Create content that still
              requires separate human review.
            </span>
          </label>
        </div>
        {outcome === 'PROPOSE_REPLACEMENT' ? (
          <div className="mt-4 grid gap-3 border-l-2 border-amber-300 pl-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-pf-deep">
              Replacement title
              <input
                required
                maxLength={200}
                value={replacement.title}
                onChange={(event) =>
                  setReplacement((value) => ({ ...value, title: event.target.value }))
                }
                className="mt-1 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
              />
            </label>
            <label className="text-sm font-medium text-pf-deep">
              Replacement category
              <input
                required
                maxLength={100}
                value={replacement.category}
                onChange={(event) =>
                  setReplacement((value) => ({ ...value, category: event.target.value }))
                }
                className="mt-1 min-h-11 w-full rounded-lg border border-pf-light bg-white px-3"
              />
            </label>
            <label className="text-sm font-medium text-pf-deep sm:col-span-2">
              Replacement content
              <textarea
                required
                rows={4}
                maxLength={5000}
                value={replacement.content}
                onChange={(event) =>
                  setReplacement((value) => ({ ...value, content: event.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
              />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-pf-deep sm:col-span-2">
              <input
                type="checkbox"
                checked={replacement.isEnabled}
                onChange={(event) =>
                  setReplacement((value) => ({ ...value, isEnabled: event.target.checked }))
                }
              />
              Enabled in the proposed canonical guidance
            </label>
          </div>
        ) : null}
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Resolution note
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={!outcome || !note.trim() || !replacementValid}
          className="mt-4 min-h-11 rounded-lg bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Recording resolution…' : 'Record resolution'}
        </button>
      </fieldset>
      {unknown ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void submit()}
          className="mt-3 min-h-11 rounded-lg border border-amber-800 px-4 text-sm font-semibold text-amber-950"
        >
          {pending ? 'Checking resolution…' : 'Retry exact resolution'}
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
          Refresh conflict
        </button>
      ) : null}
    </form>
  )
}
