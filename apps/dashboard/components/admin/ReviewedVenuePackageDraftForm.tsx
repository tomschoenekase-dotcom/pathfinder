'use client'

import { useEffect, useId, useRef, useState } from 'react'

import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  tenantId: string
  venueId: string
  support?: { requestId: string; expectedVersion: number }
  intakeRunId?: string
  prefillCandidate?: ReviewedVenuePackageDraftCandidate
}

export type ReviewedVenuePackageDraftCandidate = {
  identity: string
  expectedCandidateHash: string
  payload: NonNullable<
    inferRouterOutputs<AppRouter>['admin']['getIntakeVenuePackageCandidate']['payload']
  >
  source: {
    kind: string
    label: string
    evidenceCount: number
    discrepancyCount: number
    confidence: number | null
  }
  warnings: readonly string[]
}

function candidateText(candidate: ReviewedVenuePackageDraftCandidate | undefined) {
  return candidate ? JSON.stringify(candidate.payload, null, 2) : ''
}

export function ReviewedVenuePackageDraftForm(props: Props) {
  const client = useTRPCClient()
  const scopeKey = `${props.tenantId}:${props.venueId}:${props.support?.requestId ?? ''}:${props.intakeRunId ?? ''}:${props.prefillCandidate?.identity ?? ''}`
  const instanceId = useId()
  const titleId = `${instanceId}-draft-title`
  const editorId = `${instanceId}-reviewed-package-json`
  const [text, setText] = useState(() => candidateText(props.prefillCandidate))
  const [reviewed, setReviewed] = useState<unknown>(null)
  const [draftKey, setDraftKey] = useState(() =>
    props.prefillCandidate ? '' : crypto.randomUUID(),
  )
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [stateScope, setStateScope] = useState(scopeKey)
  const inFlight = useRef(false)
  const attemptedKey = useRef(false)
  const renderedScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    scopeGeneration.current += 1
    inFlight.current = false
  }
  const scopeReady = stateScope === scopeKey

  useEffect(() => {
    setText(candidateText(props.prefillCandidate))
    setStateScope(scopeKey)
    setReviewed(null)
    setDraftKey(props.prefillCandidate ? '' : crypto.randomUUID())
    setCompleted(false)
    setBusy(false)
    inFlight.current = false
    attemptedKey.current = false
    setMessage(null)
    // The candidate identity is part of scopeKey; equal identities intentionally retain review state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  function review() {
    if (!scopeReady) return
    setMessage(null)
    try {
      setReviewed(JSON.parse(text))
    } catch {
      setReviewed(null)
      setMessage('Enter valid VenuePackage JSON before review.')
    }
  }

  async function createDraft() {
    if (
      !scopeReady ||
      !reviewed ||
      inFlight.current ||
      (props.intakeRunId && !props.prefillCandidate)
    )
      return
    inFlight.current = true
    const generation = scopeGeneration.current
    const key = renderedScope.current
    attemptedKey.current = true
    setBusy(true)
    setMessage(null)
    try {
      const common = {
        tenantId: props.tenantId,
        venueId: props.venueId,
        draftKey,
        payload: reviewed as never,
      }
      const result =
        props.prefillCandidate && props.intakeRunId
          ? await client.admin.createAndLinkIntakeCandidateDraft.mutate({
              tenantId: props.tenantId,
              venueId: props.venueId,
              runId: props.intakeRunId,
              expectedCandidateHash: props.prefillCandidate.expectedCandidateHash,
            })
          : props.support
            ? await client.admin.createAndLinkSupportReviewedVenuePackageDraft.mutate({
                ...common,
                supportRequestId: props.support.requestId,
                expectedVersion: props.support.expectedVersion,
              })
            : await client.admin.createReviewedVenuePackageDraft.mutate(common)
      if (scopeGeneration.current !== generation || renderedScope.current !== key) return
      setMessage(
        result.value.replayed
          ? 'The exact existing DRAFT was reconciled.'
          : props.support || props.intakeRunId
            ? 'The reviewed DRAFT was created and linked atomically.'
            : 'The reviewed DRAFT was created with complete semantic evidence.',
      )
      if (props.prefillCandidate) {
        setCompleted(true)
      } else {
        setDraftKey(crypto.randomUUID())
        attemptedKey.current = false
        setReviewed(null)
      }
    } catch {
      if (scopeGeneration.current !== generation || renderedScope.current !== key) return
      setMessage(
        'The reviewed DRAFT outcome could not be confirmed. Retry unchanged to reconcile the same request identity.',
      )
    } finally {
      if (scopeGeneration.current === generation && renderedScope.current === key) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section className="rounded-2xl border border-pf-light bg-white p-5" aria-labelledby={titleId}>
      <h3 id={titleId} className="font-semibold text-pf-deep">
        Create a reviewed DRAFT
      </h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/75">
        Review the exact strict payload before submission. The request identity remains fixed for
        safe retry until success. Creation uses the canonical gated semantic-analysis pipeline and
        records only a DRAFT; it never approves, applies, publishes, or reverts content.
      </p>
      {props.prefillCandidate ? (
        <div className="mt-4 rounded-xl border border-pf-light bg-slate-50 p-4">
          <p className="text-sm font-semibold text-pf-deep">
            Candidate from {props.prefillCandidate.source.label}
          </p>
          <p className="mt-1 text-xs text-pf-deep/70">
            {props.prefillCandidate.source.kind.replaceAll('_', ' ')} ·{' '}
            {props.prefillCandidate.source.evidenceCount} evidence item(s) ·{' '}
            {props.prefillCandidate.source.discrepancyCount} discrepancy flag(s)
            {props.prefillCandidate.source.confidence === null
              ? ''
              : ` · ${Math.round(props.prefillCandidate.source.confidence * 100)}% confidence`}
          </p>
          {props.prefillCandidate.warnings.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
              {props.prefillCandidate.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-pf-deep/65">No candidate warnings were reported.</p>
          )}
        </div>
      ) : null}
      {props.intakeRunId && !props.prefillCandidate ? (
        <p
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="alert"
        >
          Load the server-reviewed intake candidate before creating a linked DRAFT. Browser-authored
          JSON cannot be linked to intake evidence.
        </p>
      ) : null}
      <label htmlFor={editorId} className="mt-4 block text-sm font-semibold text-pf-deep">
        VenuePackage payload JSON
      </label>
      <textarea
        id={editorId}
        value={scopeReady ? text : candidateText(props.prefillCandidate)}
        readOnly={Boolean(props.prefillCandidate)}
        onChange={(event) => {
          if (props.prefillCandidate) return
          if (attemptedKey.current) {
            setDraftKey(crypto.randomUUID())
            attemptedKey.current = false
          }
          setText(event.target.value)
          setReviewed(null)
          setMessage(null)
        }}
        rows={12}
        spellCheck={false}
        className="mt-2 w-full rounded-xl border border-pf-light p-3 font-mono text-xs"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={
            !scopeReady ||
            busy ||
            completed ||
            Boolean(props.intakeRunId && !props.prefillCandidate) ||
            !text.trim()
          }
          onClick={review}
          className="rounded-lg bg-pf-deep px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {props.prefillCandidate ? 'Review exact candidate' : 'Review exact payload'}
        </button>
        <button
          type="button"
          disabled={
            !scopeReady ||
            busy ||
            completed ||
            Boolean(props.intakeRunId && !props.prefillCandidate) ||
            !reviewed
          }
          onClick={() => void createDraft()}
          className="rounded-lg bg-pf-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {props.prefillCandidate ? 'Create and link DRAFT only' : 'Create DRAFT only'}
        </button>
      </div>
      {scopeReady && reviewed ? (
        <div
          className="mt-4 max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100"
          aria-label="Reviewed VenuePackage payload"
        >
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(reviewed, null, 2)}</pre>
        </div>
      ) : null}
      {scopeReady && message ? (
        <p className="mt-3 text-sm text-pf-deep" role="status">
          {message}
        </p>
      ) : null}
    </section>
  )
}
