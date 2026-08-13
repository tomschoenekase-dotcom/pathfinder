'use client'

import { useRouter } from 'next/navigation'
import React, { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Projection = inferRouterOutputs<AppRouter>['admin']['getOffboardingExportFinalization']
type ExportKind = Projection['targets'][number]['remainingExportKinds'][number]
type Action = 'review' | 'finalize'

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function OffboardingExportFinalizer({
  tenantId,
  projection,
  venueNames,
}: {
  tenantId: string
  projection: Projection
  venueNames: Record<string, string>
}) {
  const scopeKey = `${tenantId}:${projection.planId}:${projection.status}:${projection.expectedUpdatedAt}:${projection.remainingArtifacts}:${projection.exportActions.review.allowed}:${projection.exportActions.finalize.allowed}:${projection.targets
    .map((target) => `${target.venueId}:${target.remainingExportKinds.join(',')}`)
    .join('|')}`
  const latestScope = useRef(scopeKey)
  latestScope.current = scopeKey
  return (
    <OffboardingExportFinalizerScoped
      key={scopeKey}
      tenantId={tenantId}
      projection={projection}
      venueNames={venueNames}
      scopeKey={scopeKey}
      isLatestScope={() => latestScope.current === scopeKey}
    />
  )
}

function OffboardingExportFinalizerScoped({
  tenantId,
  projection,
  venueNames,
  scopeKey,
  isLatestScope,
}: {
  tenantId: string
  projection: Projection
  venueNames: Record<string, string>
  scopeKey: string
  isLatestScope: () => boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const firstTarget = projection.targets.find((target) => target.remainingExportKinds.length > 0)
  const [venueId, setVenueId] = useState(firstTarget?.venueId ?? '')
  const selectedTarget = projection.targets.find((target) => target.venueId === venueId)
  const [kind, setKind] = useState<ExportKind | ''>(firstTarget?.remainingExportKinds[0] ?? '')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [locked, setLocked] = useState(false)
  const [readyScope, setReadyScope] = useState(scopeKey)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const renderedScope = useRef(scopeKey)
  const selection = useRef({
    venueId: firstTarget?.venueId ?? '',
    kind: (firstTarget?.remainingExportKinds[0] ?? '') as ExportKind | '',
    confirmed: false,
  })
  const generation = useRef(0)
  const inFlight = useRef(false)
  const operationIds = useRef(new Map<string, string>())
  const feedbackHeading = useRef<HTMLHeadingElement>(null)

  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    generation.current += 1
    inFlight.current = false
    operationIds.current.clear()
  }
  const scopeReady = readyScope === scopeKey

  useEffect(() => {
    setReadyScope(scopeKey)
    setConfirmed(false)
    setBusy(null)
    setLocked(false)
    setError(null)
    setNotice(null)
    inFlight.current = false
    operationIds.current.clear()
  }, [scopeKey])

  useEffect(() => {
    if (error || notice) feedbackHeading.current?.focus()
  }, [error, notice])

  function current(startedGeneration: number, startedScope: string) {
    return (
      isLatestScope() &&
      generation.current === startedGeneration &&
      renderedScope.current === startedScope
    )
  }

  function selectVenue(nextVenueId: string) {
    if (inFlight.current || locked) return
    const nextTarget = projection.targets.find((target) => target.venueId === nextVenueId)
    selection.current = {
      venueId: nextVenueId,
      kind: nextTarget?.remainingExportKinds[0] ?? '',
      confirmed: false,
    }
    setVenueId(nextVenueId)
    setKind(nextTarget?.remainingExportKinds[0] ?? '')
    setConfirmed(false)
    setError(null)
    setNotice(null)
  }

  function selectKind(nextKind: ExportKind) {
    if (inFlight.current || locked) return
    selection.current = { ...selection.current, kind: nextKind, confirmed: false }
    setKind(nextKind)
    setConfirmed(false)
    setError(null)
    setNotice(null)
  }

  async function run(action: Action) {
    const gate = projection.exportActions[action]
    const exactSelection = selection.current
    const exactTarget = projection.targets.find(
      (target) => target.venueId === exactSelection.venueId,
    )
    if (
      !scopeReady ||
      locked ||
      inFlight.current ||
      !exactSelection.confirmed ||
      !gate.allowed ||
      (action === 'finalize' &&
        (!exactSelection.kind ||
          !exactTarget ||
          !exactTarget.remainingExportKinds.includes(exactSelection.kind)))
    )
      return
    inFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scopeKey
    const identity =
      action === 'review'
        ? `review:${projection.planId}:${projection.expectedUpdatedAt}`
        : `finalize:${projection.planId}:${projection.expectedUpdatedAt}:${exactSelection.venueId}:${exactSelection.kind}`
    const operationId = operationIds.current.get(identity) ?? crypto.randomUUID()
    operationIds.current.set(identity, operationId)
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      if (action === 'review') {
        const result = await client.admin.reviewOffboardingPlanExports.mutate({
          tenantId,
          planId: projection.planId,
          operationId,
          expectedUpdatedAt: projection.expectedUpdatedAt,
        })
        if (!current(startedGeneration, startedScope)) return
        if (result.planId !== projection.planId || result.status !== 'REVIEWED') {
          setError(
            'The export result could not be confirmed. Retry this unchanged action to reuse its operation identity.',
          )
          return
        }
        setNotice(
          'The declared non-deleting export matrix was reviewed. No artifact was generated.',
        )
      } else {
        const result = await client.admin.finalizeOffboardingExportArtifact.mutate({
          tenantId,
          planId: projection.planId,
          venueId: exactSelection.venueId,
          kind: exactSelection.kind as ExportKind,
          operationId,
          expectedPlanUpdatedAt: projection.expectedUpdatedAt,
        })
        if (!current(startedGeneration, startedScope)) return
        if (
          result.planId !== projection.planId ||
          result.venueId !== exactSelection.venueId ||
          result.kind !== exactSelection.kind ||
          result.status !== 'SETTLED' ||
          !result.artifactRecorded
        ) {
          setError(
            'The export result could not be confirmed. Retry this unchanged action to reuse its operation identity.',
          )
          return
        }
        setNotice(
          result.remainingArtifacts === 0
            ? 'The deterministic artifact was stored and its metadata recorded. All requested export artifact metadata is now recorded.'
            : `The deterministic ${label(result.kind)} artifact was stored and its metadata recorded. ${result.remainingArtifacts} requested artifact${result.remainingArtifacts === 1 ? ' remains' : 's remain'}.`,
        )
      }
      operationIds.current.delete(identity)
      selection.current = { ...selection.current, confirmed: false }
      setConfirmed(false)
      setLocked(true)
      router.refresh()
    } catch (cause) {
      if (!current(startedGeneration, startedScope)) return
      const code = errorCode(cause)
      if (
        code === 'NOT_FOUND' ||
        code === 'CONFLICT' ||
        code === 'PRECONDITION_FAILED' ||
        code === 'BAD_REQUEST'
      ) {
        operationIds.current.delete(identity)
        selection.current = { ...selection.current, confirmed: false }
        setConfirmed(false)
        setLocked(true)
        setError(
          'The offboarding export plan changed or is no longer available. Reload and review it.',
        )
        router.refresh()
      } else {
        setError(
          'The export result could not be confirmed. Retry this unchanged action to reuse its operation identity.',
        )
      }
    } finally {
      if (current(startedGeneration, startedScope)) {
        inFlight.current = false
        setBusy(null)
      }
    }
  }

  const action: Action | null = projection.exportActions.review.allowed
    ? 'review'
    : projection.exportActions.finalize.allowed
      ? 'finalize'
      : null

  return (
    <section
      aria-labelledby={`export-finalizer-${projection.planId}`}
      aria-busy={busy !== null}
      className="mt-5 rounded-xl border border-pf-light bg-pf-surface/35 p-4"
    >
      <h5 id={`export-finalizer-${projection.planId}`} className="font-semibold text-pf-deep">
        Deterministic export artifacts
      </h5>
      <p className="mt-2 text-sm leading-6 text-pf-deep/75">
        This action generates and stores one bounded deterministic export artifact and records its
        metadata. It does not revoke access, delete data, enforce retention, deliver a download, or
        complete offboarding.
      </p>
      <p className="mt-2 text-sm text-pf-deep/75">
        {projection.remainingArtifacts} requested artifact
        {projection.remainingArtifacts === 1 ? '' : 's'} remain.
      </p>

      {action === 'finalize' ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold text-pf-deep">
            Venue
            <select
              value={venueId}
              disabled={!scopeReady || locked || busy !== null}
              onChange={(event) => selectVenue(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            >
              {projection.targets
                .filter((target) => target.remainingExportKinds.length > 0)
                .map((target) => (
                  <option key={target.venueId} value={target.venueId}>
                    {venueNames[target.venueId] ?? 'Selected venue'}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Requested export
            <select
              value={kind}
              disabled={!scopeReady || locked || busy !== null}
              onChange={(event) => selectKind(event.target.value as ExportKind)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3"
            >
              {selectedTarget?.remainingExportKinds.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {action ? (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-sm text-pf-deep/80">
            <input
              type="checkbox"
              className="mt-1"
              checked={scopeReady && confirmed}
              disabled={!scopeReady || locked || busy !== null}
              onChange={(event) => {
                selection.current = { ...selection.current, confirmed: event.target.checked }
                setConfirmed(event.target.checked)
              }}
            />
            {action === 'review'
              ? 'I reviewed the exact venues and requested export kinds. This review creates no artifact and performs no offboarding action.'
              : 'I intend to generate and store this exact bounded export artifact. This records export evidence only.'}
          </label>
          <button
            type="button"
            disabled={!scopeReady || locked || busy !== null || !confirmed}
            onClick={() => void run(action)}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === action
              ? action === 'review'
                ? 'Recording review…'
                : 'Generating artifact…'
              : action === 'review'
                ? 'Review export matrix'
                : 'Generate and store artifact'}
          </button>
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-white p-3 text-sm text-pf-deep/75">
          {projection.exportActions.finalize.reason}
        </p>
      )}

      {error || notice ? (
        <div className="mt-4" role={error ? 'alert' : 'status'}>
          <h6 ref={feedbackHeading} tabIndex={-1} className="text-sm font-semibold text-pf-deep">
            {error ? 'Export action needs attention' : 'Export evidence recorded'}
          </h6>
          <p className={`mt-1 text-sm ${error ? 'text-rose-800' : 'text-emerald-800'}`}>
            {error ?? notice}
          </p>
        </div>
      ) : null}
    </section>
  )
}
