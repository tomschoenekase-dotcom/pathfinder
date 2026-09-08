'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const TEMPORAL_EVIDENCE_TIMEOUT_MS = 15_000

export type TemporalEvidenceReference = {
  reviewReceiptId: string
  expectedSnapshotHash: string
  claimId: string
}

export type TemporalEvidenceItem = {
  key: string
  reference: TemporalEvidenceReference
  desired: { title: string; category: string; content: string; isEnabled: boolean }
  validFrom: string
  validUntil: string
  reviewedAt: string
  sourceNames: string[]
}

type Cursor = { receiptId: string; createdAt: string; claimOffset: number }
type Listing = {
  items: TemporalEvidenceItem[]
  nextCursor: Cursor | null
  requiresTemporalEvidence: boolean
}

function readableError(cause: unknown) {
  return cause instanceof Error && cause.message
    ? cause.message
    : 'Reviewed temporal sources could not be loaded. Try again to read the current scope.'
}

function localDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function sourceNames(sourceNames: string[]) {
  const visible = sourceNames.slice(0, 3)
  const remaining = sourceNames.length - visible.length
  return `${visible.join(', ')}${remaining > 0 ? ` +${remaining} more` : ''}`
}

export function TemporalEvidenceSelector({
  tenantId,
  venueId,
  proposalId,
  proposalUpdatedAt,
  selectedKey,
  onSelect,
  onClearSelection,
  onRequirementChange,
}: {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  selectedKey: string | null
  onSelect: (item: TemporalEvidenceItem) => void
  onClearSelection: () => void
  onRequirementChange: (required: boolean | null) => void
}) {
  const client = useTRPCClient()
  const [listing, setListing] = useState<Listing | null>(null)
  const [listingScope, setListingScope] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const clientRef = useRef(client)
  clientRef.current = client
  const scope = `${tenantId}:${venueId}:${proposalId}:${new Date(proposalUpdatedAt).toISOString()}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  const load = useCallback(
    async (cursor: Cursor | undefined) => {
      const startedSequence = ++sequence.current
      const startedScope = scope
      activeRequest.current?.abort()
      const controller = new AbortController()
      activeRequest.current = controller
      setBusy(true)
      setError(null)
      try {
        const result = (await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: TEMPORAL_EVIDENCE_TIMEOUT_MS,
          request: (signal) =>
            clientRef.current.admin.listKnowledgeProposalTemporalEvidence.query(
              {
                tenantId,
                venueId,
                proposalId,
                expectedUpdatedAt: new Date(proposalUpdatedAt),
                ...(cursor ? { cursor } : {}),
              },
              { signal },
            ),
        })) as Listing
        if (sequence.current === startedSequence && currentScope.current === startedScope) {
          setListing(result)
          setListingScope(startedScope)
          onRequirementChange(result.requiresTemporalEvidence)
        }
      } catch (cause) {
        if (sequence.current === startedSequence && currentScope.current === startedScope) {
          setListing(null)
          setListingScope(null)
          setError(readableError(cause))
        }
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
        if (sequence.current === startedSequence && currentScope.current === startedScope)
          setBusy(false)
      }
    },
    [onRequirementChange, proposalId, proposalUpdatedAt, scope, tenantId, venueId],
  )

  useEffect(() => {
    sequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setListing(null)
    setListingScope(null)
    setBusy(false)
    setError(null)
    onRequirementChange(null)
    void load(undefined)
    return () => {
      sequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [load, onRequirementChange, scope])

  const visibleListing = listingScope === scope ? listing : null

  return (
    <section
      className="mt-3 border-t border-violet-200 pt-3"
      aria-label="Reviewed temporal evidence"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-950">Reviewed dated source</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Choose a reviewed source only when its text and dates match this proposed visitor fact.
            Selection does not create a draft or publish an update.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            onClearSelection()
            void load(undefined)
          }}
          disabled={busy}
          className="min-h-10 rounded-lg border border-violet-300 bg-white px-3 text-sm font-semibold text-violet-900 disabled:opacity-50"
        >
          {busy ? 'Reading sources…' : 'Refresh sources'}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {visibleListing && !visibleListing.items.length ? (
        <p className="mt-3 text-sm text-slate-600" role="status">
          No current dated sources appear on this review page. Check an earlier reviewed page if one
          is available.
        </p>
      ) : null}
      {visibleListing?.items.length ? (
        <ul className="mt-3 space-y-2" aria-label="Reviewed temporal source choices">
          {visibleListing.items.map((item) => (
            <li key={item.key} className="border-l-2 border-violet-200 bg-white px-3 py-3">
              <p className="break-words font-medium text-slate-950 [overflow-wrap:anywhere]">
                {item.desired.title}
              </p>
              <p className="mt-1 break-words text-sm leading-5 text-slate-700">
                {item.desired.content}
              </p>
              <p className="mt-2 text-xs text-slate-600">
                {localDateTime(item.validFrom)} to {localDateTime(item.validUntil)}
              </p>
              <p className="mt-1 break-words text-xs text-slate-600 [overflow-wrap:anywhere]">
                Reviewed {localDateTime(item.reviewedAt)} ·{' '}
                {sourceNames(item.sourceNames) || 'Source name unavailable'}
              </p>
              <button
                type="button"
                onClick={() => onSelect(item)}
                disabled={busy}
                aria-pressed={selectedKey === item.key}
                className="mt-3 min-h-10 rounded-lg border border-violet-300 bg-violet-50 px-3 text-sm font-semibold text-violet-900"
              >
                {selectedKey === item.key ? 'Reviewed source selected' : 'Use reviewed source'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {visibleListing?.nextCursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onClearSelection()
            void load(visibleListing.nextCursor ?? undefined)
          }}
          className="mt-3 min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 disabled:opacity-50"
        >
          {busy ? 'Loading next sources…' : 'Load next sources'}
        </button>
      ) : null}
    </section>
  )
}
