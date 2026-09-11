'use client'

import { useEffect, useRef, useState } from 'react'
import type { MediaTemporalClaim } from '@pathfinder/contracts/media-temporal-claims'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type Scope = { tenantId: string; venueId: string; projectId: string }
type Binding = {
  kind: 'place' | 'knowledge'
  itemIndex: number
  itemHash: string
  sourceIds: string[]
}
type Receipt = {
  receiptId: string
  snapshotHash: string
  requestHash?: string
  heldItems: Array<{ itemHash: string; reasons: string[] }>
  replayed: boolean
}
type EvidencePage = {
  receiptId: string
  snapshotHash: string
  requestHash: string
  text: string
  offset: number
  nextOffset: number | null
  totalCodeUnits: number
}
type RetainInput = Scope & {
  requestId: string
  sourceGeneration: string
  expectedUpdatedAt: string
  rationale: string
  claims: MediaTemporalClaim[]
  bindings: Binding[]
}
export type MediaTemporalReviewAdapter = {
  retain: (
    input: Scope & {
      requestId: string
      sourceGeneration: string
      expectedUpdatedAt: string
      rationale: string
      claims: MediaTemporalClaim[]
      bindings: Binding[]
    },
    signal: AbortSignal,
  ) => Promise<Receipt>
  readEvidence: (
    input: { tenantId: string; venueId: string; receiptId: string; offset: number },
    signal: AbortSignal,
  ) => Promise<EvidencePage>
  clarify?: (
    input: {
      tenantId: string
      venueId: string
      receiptId: string
      agentIdentityId: string
      targetKey: string
      expectedRequestHash: string
      expectedSnapshotHash: string
    },
    signal: AbortSignal,
  ) => Promise<{ questionId: string; replayed: boolean }>
}

const control =
  'min-h-11 rounded-lg border border-pf-light px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-primary disabled:opacity-50'

/** Retains an all-held temporal review without pretending it can enter the static Builder flow. */
export function MediaTemporalReviewPanel({
  scope,
  sourceGeneration,
  expectedUpdatedAt,
  rationale,
  claims,
  bindings,
  allHeld,
  blocked,
  adapter,
}: {
  scope: Scope
  sourceGeneration: string
  expectedUpdatedAt: string
  rationale: string
  claims: MediaTemporalClaim[]
  bindings: Binding[]
  allHeld: boolean
  blocked: boolean
  adapter?: MediaTemporalReviewAdapter
}) {
  const client = useTRPCClient()
  const scopeKey = JSON.stringify([
    scope.tenantId,
    scope.venueId,
    scope.projectId,
    sourceGeneration,
    expectedUpdatedAt,
  ])
  const requestRef = useRef<RetainInput | null>(null)
  const controller = useRef<AbortController | null>(null)
  const renderedScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    scopeGeneration.current += 1
  }
  const [dataScopeKey, setDataScopeKey] = useState(scopeKey)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [evidence, setEvidence] = useState<EvidencePage | null>(null)
  const [evidenceOffsets, setEvidenceOffsets] = useState<number[]>([0])
  const [error, setError] = useState<string | null>(null)
  const [agentIdentityId, setAgentIdentityId] = useState('')
  const [questionId, setQuestionId] = useState<string | null>(null)
  const [targetKey, setTargetKey] = useState('')
  useEffect(() => {
    requestRef.current = null
    controller.current?.abort()
    setReceipt(null)
    setEvidence(null)
    setEvidenceOffsets([0])
    setBusy(false)
    setError(null)
    setAgentIdentityId('')
    setQuestionId(null)
    setTargetKey('')
    setDataScopeKey(scopeKey)
  }, [scopeKey, sourceGeneration, expectedUpdatedAt])
  useEffect(
    () => () => {
      scopeGeneration.current += 1
      controller.current?.abort()
    },
    [],
  )

  const run = async <T,>(generation: number, work: (signal: AbortSignal) => Promise<T>) => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setBusy(true)
    setError(null)
    try {
      return await runBoundedClientRequest({
        parentSignal: next.signal,
        timeoutMs: 15_000,
        request: work,
      })
    } finally {
      if (controller.current === next) {
        controller.current = null
        if (scopeGeneration.current === generation) setBusy(false)
      }
    }
  }
  const readEvidence = async (saved: Receipt, offset: number) => {
    const generation = scopeGeneration.current
    const page = await run(generation, (signal) =>
      adapter
        ? adapter.readEvidence({ ...scope, receiptId: saved.receiptId, offset }, signal)
        : runBoundedClientRequest({
            parentSignal: signal,
            timeoutMs: 15_000,
            request: (requestSignal) =>
              client.mediaIngestion.readTemporalReviewEvidence.query(
                {
                  tenantId: scope.tenantId,
                  venueId: scope.venueId,
                  receiptId: saved.receiptId,
                  offset,
                },
                { signal: requestSignal },
              ),
          }),
    )
    if (scopeGeneration.current !== generation) return
    if (
      page.receiptId !== saved.receiptId ||
      page.snapshotHash !== saved.snapshotHash ||
      (saved.requestHash && page.requestHash !== saved.requestHash) ||
      page.offset !== offset
    )
      throw new Error('Evidence page identity changed.')
    setEvidence(page)
  }
  const retain = async () => {
    if (busy || blocked || !allHeld || !rationale.trim() || dataScopeKey !== scopeKey) return
    requestRef.current ??= {
      ...scope,
      requestId: crypto.randomUUID(),
      sourceGeneration,
      expectedUpdatedAt,
      rationale: rationale.trim(),
      claims: structuredClone(claims),
      bindings: structuredClone(bindings),
    }
    const input = requestRef.current
    const generation = scopeGeneration.current
    try {
      const saved = await run(generation, (signal) =>
        adapter
          ? adapter.retain(input, signal)
          : client.mediaIngestion.retainTemporalReview.mutate(input, { signal }),
      )
      if (scopeGeneration.current !== generation) return
      setReceipt(saved)
      setTargetKey('')
      try {
        await readEvidence(saved, 0)
      } catch {
        if (scopeGeneration.current === generation)
          setError(
            'The receipt was saved, but its evidence page could not be read. Try readback again.',
          )
      }
    } catch {
      if (scopeGeneration.current === generation)
        setError('The receipt was not confirmed. Retry the same frozen request.')
    }
  }
  const clarify = async () => {
    if (!receipt || !evidence || !agentIdentityId.trim() || !targetKey || busy) return
    const generation = scopeGeneration.current
    try {
      const result = await run(generation, (signal) =>
        adapter?.clarify
          ? adapter.clarify(
              {
                tenantId: scope.tenantId,
                venueId: scope.venueId,
                receiptId: receipt.receiptId,
                agentIdentityId: agentIdentityId.trim(),
                targetKey,
                expectedRequestHash: evidence.requestHash,
                expectedSnapshotHash: evidence.snapshotHash,
              },
              signal,
            )
          : client.mediaIngestion.createTemporalReceiptClarification.mutate(
              {
                tenantId: scope.tenantId,
                venueId: scope.venueId,
                receiptId: receipt.receiptId,
                agentIdentityId: agentIdentityId.trim(),
                targetKey,
                expectedRequestHash: evidence.requestHash,
                expectedSnapshotHash: evidence.snapshotHash,
              },
              { signal },
            ),
      )
      if (scopeGeneration.current === generation) setQuestionId(result.questionId)
    } catch {
      if (scopeGeneration.current === generation)
        setError('The local clarification was not created. Check the scoped Content identity.')
    }
  }

  if (!allHeld || dataScopeKey !== scopeKey) return null
  const frozenClaims = requestRef.current?.claims ?? []
  const heldItemHashes = new Set(receipt?.heldItems.map((item) => item.itemHash) ?? [])
  const heldTargets = [
    ...new Set(
      frozenClaims
        .filter((claim) => heldItemHashes.has(claim.targetItemHash))
        .map((claim) => claim.targetKey),
    ),
  ].sort()
  return (
    <section
      className="border-l-4 border-amber-500 bg-amber-50 px-4 py-4"
      aria-labelledby="temporal-receipt-heading"
    >
      <h3 id="temporal-receipt-heading" className="text-base font-semibold text-pf-deep">
        Retain this held review
      </h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-pf-deep/75">
        Every item is held, so none can enter the static Builder proposal. Keep the exact evidence
        as a review receipt instead. This does not publish or activate content.
      </p>
      {!receipt ? (
        <button
          type="button"
          className={`${control} mt-3 bg-pf-deep text-white`}
          disabled={busy || blocked || !rationale.trim()}
          onClick={() => void retain()}
        >
          {busy
            ? 'Retaining evidence…'
            : requestRef.current
              ? 'Retry same evidence receipt'
              : 'Retain evidence receipt'}
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <dl className="grid gap-x-5 gap-y-2 text-xs sm:grid-cols-[8rem_1fr]">
            <dt className="font-semibold text-pf-deep">Receipt</dt>
            <dd className="break-all font-mono">{receipt.receiptId}</dd>
            <dt className="font-semibold text-pf-deep">Request hash</dt>
            <dd className="break-all font-mono">{evidence?.requestHash ?? 'Loading…'}</dd>
            <dt className="font-semibold text-pf-deep">Snapshot hash</dt>
            <dd className="break-all font-mono">{receipt.snapshotHash}</dd>
          </dl>
          {evidence ? (
            <details className="border-t border-amber-200 pt-3">
              <summary className="min-h-11 cursor-pointer text-sm font-semibold text-pf-primary">
                Read retained evidence
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-white p-3 text-xs">
                {evidence.text}
              </pre>
              <p className="mt-1 text-xs text-pf-deep/65">
                Showing {evidence.text.length.toLocaleString()} of{' '}
                {evidence.totalCodeUnits.toLocaleString()} code units
                {evidence.nextOffset === null ? '.' : '; more remains in the bounded reader.'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={control}
                  disabled={busy || evidenceOffsets.length === 1}
                  onClick={() => {
                    const generation = scopeGeneration.current
                    const previous = evidenceOffsets.slice(0, -1)
                    const offset = previous.at(-1) ?? 0
                    setEvidenceOffsets(previous.length ? previous : [0])
                    void readEvidence(receipt, offset).catch(() => {
                      if (scopeGeneration.current === generation)
                        setError('Could not read the previous evidence page.')
                    })
                  }}
                >
                  Previous evidence
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={busy || evidence.nextOffset === null}
                  onClick={() => {
                    if (evidence.nextOffset === null) return
                    const generation = scopeGeneration.current
                    const offset = evidence.nextOffset
                    setEvidenceOffsets((current) => [...current, offset])
                    void readEvidence(receipt, offset).catch(() => {
                      if (scopeGeneration.current === generation) {
                        setEvidenceOffsets((current) => current.slice(0, -1))
                        setError('Could not read the next evidence page.')
                      }
                    })
                  }}
                >
                  Next evidence
                </button>
              </div>
            </details>
          ) : (
            <button
              type="button"
              className={control}
              disabled={busy}
              onClick={() =>
                void (() => {
                  const generation = scopeGeneration.current
                  return readEvidence(receipt, 0).catch(() => {
                    if (scopeGeneration.current === generation)
                      setError('Could not read the retained evidence. Try again.')
                  })
                })()
              }
            >
              {busy ? 'Loading evidence…' : 'Retry evidence readback'}
            </button>
          )}
          <div className="border-t border-amber-200 pt-3">
            <label className="block text-sm font-medium text-pf-deep">
              Held target to clarify
              <select
                className={`${control} mt-2 block w-full`}
                value={targetKey}
                onChange={(event) => {
                  setTargetKey(event.target.value)
                  setQuestionId(null)
                }}
              >
                <option value="">Choose a held target</option>
                {heldTargets.map((heldTarget) => (
                  <option key={heldTarget} value={heldTarget}>
                    {heldTarget}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-pf-deep">
              Optional scoped Content identity
              <input
                className={`${control} mt-2 block w-full`}
                value={agentIdentityId}
                onChange={(event) => setAgentIdentityId(event.target.value)}
                placeholder="Agent identity ID"
              />
            </label>
            <button
              type="button"
              className={`${control} mt-2`}
              disabled={busy || !evidence || !agentIdentityId.trim() || !targetKey}
              onClick={() => void clarify()}
            >
              {busy ? 'Creating question…' : 'Create local clarification'}
            </button>
            {questionId ? (
              <p role="status" className="mt-2 text-sm text-emerald-800">
                Local question created: <span className="font-mono">{questionId}</span>
              </p>
            ) : null}
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </section>
  )
}
