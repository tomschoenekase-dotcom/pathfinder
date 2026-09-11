'use client'

import { useRef, useState } from 'react'
import React from 'react'

export type FounderCharacterCandidate = {
  id: string
  tenantId: string
  venueId: string
  clientName?: string | null
  venueName?: string | null
  characterId: string
  displayName: string
  version: number
  revision: number
  artifactFingerprint: string
  brief: string
  rationale: string
  provenance: string
  previewHref: string | null
  current: boolean
}

export type FounderCharacterDecision = {
  briefId: string
  tenantId: string
  venueId: string
  expectedVersion: number
  expectedRevision: number
  expectedArtifactFingerprint: string
  operationId: string
  decision: 'ACCEPT' | 'REJECT' | 'REVISE'
  revisionRequest?: string
}

type Props = {
  candidates: readonly FounderCharacterCandidate[]
  onDecision: (
    input: FounderCharacterDecision,
  ) => Promise<{ decision: string; jobId: string | null }>
}

const PREVIEW_PREFIX = '/api/admin/character-candidate-preview?'

function safePreviewHref(candidate: FounderCharacterCandidate) {
  const value = candidate.previewHref
  if (!value?.startsWith(PREVIEW_PREFIX) || value.includes('#')) return null
  try {
    const params = new URL(value, 'https://candidate-preview.invalid').searchParams
    const expected = {
      tenantId: candidate.tenantId,
      venueId: candidate.venueId,
      briefId: candidate.id,
      expectedVersion: String(candidate.version),
      expectedRevision: String(candidate.revision),
      expectedArtifactFingerprint: candidate.artifactFingerprint,
    }
    return Object.entries(expected).every(([key, value]) => params.get(key) === value)
      ? value
      : null
  } catch {
    return null
  }
}

function makeOperationId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('A secure operation identifier is unavailable')
  }
  return crypto.randomUUID()
}

export function FounderCharacterCandidateReview({ candidates, onDecision }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const [decided, setDecided] = useState<Record<string, boolean>>({})
  const [feedback, setFeedback] = useState<Record<string, string>>({})
  const operations = useRef<Record<string, string>>({})

  function snapshotKey(candidate: FounderCharacterCandidate) {
    return JSON.stringify([
      candidate.id,
      candidate.tenantId,
      candidate.venueId,
      candidate.version,
      candidate.revision,
      candidate.artifactFingerprint,
    ])
  }

  function requestValue(candidate: FounderCharacterCandidate) {
    return drafts[snapshotKey(candidate)] ?? ''
  }

  async function decide(
    candidate: FounderCharacterCandidate,
    decision: FounderCharacterDecision['decision'],
  ) {
    const snapshot = snapshotKey(candidate)
    if (
      pendingRef.current ||
      !candidate.current ||
      decided[snapshot] ||
      (decision === 'ACCEPT' && !loaded[snapshot])
    )
      return
    const revisionRequest = requestValue(candidate).trim()
    if (decision === 'REVISE' && !revisionRequest) {
      setFeedback((current) => ({
        ...current,
        [snapshot]: 'Describe the change you want before requesting a revision.',
      }))
      return
    }
    const operationKey = JSON.stringify([
      snapshot,
      decision,
      decision === 'REVISE' ? revisionRequest : '',
    ])
    const operationId = operations.current[operationKey] ?? makeOperationId()
    operations.current[operationKey] = operationId
    pendingRef.current = operationKey
    setPending(operationKey)
    setFeedback((current) => ({ ...current, [snapshot]: '' }))
    try {
      const result = await onDecision({
        briefId: candidate.id,
        tenantId: candidate.tenantId,
        venueId: candidate.venueId,
        expectedVersion: candidate.version,
        expectedRevision: candidate.revision,
        expectedArtifactFingerprint: candidate.artifactFingerprint,
        operationId,
        decision,
        ...(decision === 'REVISE' ? { revisionRequest } : {}),
      })
      setDecided((current) => ({ ...current, [snapshot]: true }))
      setFeedback((current) => ({
        ...current,
        [snapshot]: `${result.decision} recorded${result.jobId ? ` · job ${result.jobId}` : ''}.`,
      }))
    } catch {
      setFeedback((current) => ({
        ...current,
        [snapshot]:
          'This candidate changed or the decision could not be confirmed. Retry to use the same operation.',
      }))
    } finally {
      pendingRef.current = null
      setPending(null)
    }
  }

  if (!candidates.length) {
    return (
      <section
        aria-labelledby="character-candidates-heading"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <h2 id="character-candidates-heading" className="font-semibold text-slate-950">
          Character candidates
        </h2>
        <p className="mt-2 text-sm text-slate-600">No candidates are ready for founder review.</p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="character-candidates-heading"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-sky-800">Founder review</p>
          <h2
            id="character-candidates-heading"
            className="mt-1 text-lg font-semibold text-slate-950"
          >
            Choose a character candidate
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Compare the prepared variants, then accept, reject, or describe a bounded revision. This
            does not approve a final Tochi appearance.
          </p>
        </div>
        <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          {candidates.length} {candidates.length === 1 ? 'candidate' : 'candidates'}
        </span>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {candidates.map((candidate) => {
          const href = safePreviewHref(candidate)
          const previewKey = snapshotKey(candidate)
          const isLoaded = Boolean(loaded[previewKey])
          const isFailed = Boolean(failed[previewKey])
          const busy = pending !== null
          const isDecided = Boolean(decided[previewKey])
          return (
            <article
              key={candidate.id}
              className={`rounded-xl border p-4 ${candidate.current ? 'border-sky-300 bg-sky-50/30' : 'border-slate-200 bg-white'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-950">{candidate.displayName}</h3>
                  <p className="mt-1 text-xs font-medium text-slate-600">
                    {candidate.clientName ?? candidate.tenantId} ·{' '}
                    {candidate.venueName ?? candidate.venueId}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Version {candidate.version} · revision {candidate.revision} ·{' '}
                    {candidate.current ? 'current candidate' : 'stale candidate'}
                  </p>
                </div>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">
                  {candidate.characterId}
                </span>
              </div>
              <div className="mt-4 flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {href && !isFailed ? (
                  <img
                    src={href}
                    alt={`${candidate.displayName} candidate preview`}
                    className={`max-h-40 w-full object-contain ${isLoaded ? '' : 'absolute opacity-0'}`}
                    ref={(image) => {
                      if (image?.complete && image.naturalWidth > 0 && !loaded[previewKey]) {
                        setLoaded((current) => ({ ...current, [previewKey]: true }))
                      }
                    }}
                    onLoad={() => setLoaded((current) => ({ ...current, [previewKey]: true }))}
                    onError={() => {
                      setLoaded((current) => ({ ...current, [previewKey]: false }))
                      setFailed((current) => ({ ...current, [previewKey]: true }))
                    }}
                  />
                ) : (
                  <p className="px-4 text-center text-sm text-slate-500">
                    Preview unavailable. Ask for a verified preview before accepting.
                  </p>
                )}
                {href && !isLoaded && !isFailed ? (
                  <span className="px-4 text-center text-sm text-slate-500">
                    Loading verified preview…
                  </span>
                ) : null}
              </div>
              <dl className="mt-4 space-y-3 text-sm">
                <div>
                  <dt className="font-semibold text-slate-700">Brief</dt>
                  <dd className="mt-1 leading-5 text-slate-600">{candidate.brief}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Why this variant</dt>
                  <dd className="mt-1 leading-5 text-slate-600">{candidate.rationale}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-700">Source</dt>
                  <dd className="mt-1 leading-5 text-slate-600">{candidate.provenance}</dd>
                </div>
              </dl>
              <label
                className="mt-4 block text-sm font-semibold text-slate-700"
                htmlFor={`revision-${candidate.id}`}
              >
                Revision request{' '}
                <span className="font-normal text-slate-500">
                  (optional unless requesting a revision)
                </span>
              </label>
              <textarea
                id={`revision-${candidate.id}`}
                value={requestValue(candidate)}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [previewKey]: event.target.value }))
                }
                disabled={busy || isDecided}
                rows={3}
                maxLength={2000}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:bg-slate-100"
                placeholder="Describe one change for the next candidate…"
              />
              {!candidate.current ? (
                <p className="mt-2 text-sm font-medium text-amber-800">
                  This candidate is stale. Refresh before deciding.
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || isDecided || !candidate.current || !isLoaded}
                  onClick={() => void decide(candidate, 'ACCEPT')}
                  className="min-h-10 rounded-lg bg-sky-700 px-3 text-sm font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Saving…' : isDecided ? 'Decision recorded' : 'Accept candidate'}
                </button>
                <button
                  type="button"
                  disabled={busy || isDecided || !candidate.current}
                  onClick={() => void decide(candidate, 'REJECT')}
                  className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={busy || isDecided || !candidate.current}
                  onClick={() => void decide(candidate, 'REVISE')}
                  className="min-h-10 rounded-lg border border-sky-200 px-3 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Request revision
                </button>
              </div>
              {feedback[previewKey] ? (
                <p className="mt-3 text-sm text-slate-700" role="status">
                  {feedback[previewKey]}
                </p>
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}
