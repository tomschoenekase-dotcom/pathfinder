'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type PackageReview = inferRouterOutputs<AppRouter>['admin']['getVenuePackageForReview']
type LifecycleAction = 'approve' | 'apply' | 'revert'

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The venue-package action could not be confirmed.'
}

export function VenuePackageLifecycleControls({
  tenantId,
  venueId,
  initialPackage,
}: {
  tenantId: string
  venueId: string
  initialPackage: PackageReview
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [current, setCurrent] = useState(initialPackage)
  const [confirmed, setConfirmed] = useState(false)
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false)
  const [warningsExpanded, setWarningsExpanded] = useState(false)
  const [refreshedConflict, setRefreshedConflict] = useState(false)
  const [selectionUnavailable, setSelectionUnavailable] = useState(false)
  const [busy, setBusy] = useState<LifecycleAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const actionInFlight = useRef(false)
  const commandKeys = useRef(new Map<string, string>())
  const scopeGeneration = useRef(0)

  useEffect(() => {
    scopeGeneration.current += 1
    setCurrent(initialPackage)
    setConfirmed(false)
    setWarningsAcknowledged(false)
    setWarningsExpanded(false)
    setRefreshedConflict(false)
    setSelectionUnavailable(false)
    setBusy(null)
    setError(null)
    setNotice(null)
    actionInFlight.current = false
    commandKeys.current.clear()
  }, [initialPackage, tenantId, venueId])

  const warningCount = current.validationReport.warnings.length
  const allWarningsVisible = warningCount <= 20 || warningsExpanded
  const visibleWarnings = allWarningsVisible
    ? current.validationReport.warnings
    : current.validationReport.warnings.slice(0, 20)
  const reviewComplete =
    current.validationReport.errors.length === 0 &&
    current.validationReport.semanticDuplicateScan.status === 'COMPLETE'
  const availableAction: LifecycleAction | null =
    current.status === 'DRAFT'
      ? 'approve'
      : current.status === 'APPROVED'
        ? 'apply'
        : current.status === 'APPLIED'
          ? 'revert'
          : null
  const actionLabel =
    availableAction === 'approve'
      ? 'Approve reviewed package'
      : availableAction === 'apply'
        ? 'Apply approved package'
        : availableAction === 'revert'
          ? 'Revert applied package'
          : null

  async function loadExactRevision(target: PackageReview) {
    return client.admin.getVenuePackageForReview.query({
      tenantId,
      venueId,
      packageId: target.id,
    })
  }

  async function refreshAfterConflict(target: PackageReview) {
    const refreshed = await loadExactRevision(target)
    setCurrent(refreshed)
    setConfirmed(false)
    setWarningsAcknowledged(false)
    setWarningsExpanded(false)
    setRefreshedConflict(true)
  }

  async function runLifecycle(action: LifecycleAction) {
    if (actionInFlight.current || action !== availableAction || !confirmed || refreshedConflict)
      return
    if (!reviewComplete && action !== 'revert') return
    if (action === 'approve' && warningCount > 0 && !warningsAcknowledged) return
    actionInFlight.current = true
    const scope = scopeGeneration.current
    setBusy(action)
    setError(null)
    setNotice(null)
    const target = current
    const commandIdentity = `${target.id}:${action}:${target.updatedAt.toISOString()}`
    const commandKey = commandKeys.current.get(commandIdentity) ?? crypto.randomUUID()
    commandKeys.current.set(commandIdentity, commandKey)
    const input = {
      tenantId,
      venueId,
      id: target.id,
      expectedUpdatedAt: target.updatedAt,
      commandKey,
    }

    try {
      if (action === 'approve') {
        await client.admin.approveVenuePackage.mutate({
          ...input,
          acknowledgedWarningDigest: target.previewPlan.warningDigest,
          acknowledgedPayloadHash: target.previewPlan.payloadHash,
        })
      } else if (action === 'apply') {
        await client.admin.applyVenuePackage.mutate(input)
      } else {
        await client.admin.revertVenuePackage.mutate(input)
      }
      if (scopeGeneration.current !== scope) return
      const refreshed = await loadExactRevision(target)
      if (scopeGeneration.current !== scope) return
      setCurrent(refreshed)
      setConfirmed(false)
      setWarningsAcknowledged(false)
      setWarningsExpanded(false)
      setRefreshedConflict(false)
      setNotice(
        action === 'approve'
          ? 'Package approved. Applying it remains a separate action.'
          : action === 'apply'
            ? 'Package applied atomically.'
            : 'Package reverted to its exact approved base.',
      )
      router.refresh()
    } catch (cause) {
      if (scopeGeneration.current !== scope) return
      const code = errorCode(cause)
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'BAD_REQUEST') {
        commandKeys.current.delete(commandIdentity)
        try {
          await refreshAfterConflict(target)
          if (scopeGeneration.current !== scope) return
          setError(
            code === 'CONFLICT'
              ? 'This package changed. Review the refreshed revision before choosing an action.'
              : 'The stored review evidence is no longer acceptable. Review the authoritative revision before choosing an action.',
          )
        } catch (refreshCause) {
          if (scopeGeneration.current !== scope) return
          if (errorCode(refreshCause) === 'NOT_FOUND') {
            setSelectionUnavailable(true)
            setError('This package is no longer available in the selected tenant and venue scope.')
          } else {
            setRefreshedConflict(true)
            setError('This package changed, and its current revision could not be loaded. Reload.')
          }
        }
      } else if (code === 'NOT_FOUND') {
        setSelectionUnavailable(true)
        setError('This package is no longer available in the selected tenant and venue scope.')
      } else {
        setError(
          `${errorMessage(cause)} Retry is safe and will use the same command identity until the exact outcome is confirmed.`,
        )
      }
    } finally {
      if (scopeGeneration.current === scope) {
        actionInFlight.current = false
        setBusy(null)
      }
    }
  }

  return (
    <section
      aria-labelledby="package-lifecycle-heading"
      aria-busy={busy !== null}
      className="rounded-2xl border border-pf-light bg-white p-5"
    >
      <h4 id="package-lifecycle-heading" className="font-semibold text-pf-deep">
        Package lifecycle
      </h4>
      <p className="mt-2 text-sm leading-6 text-pf-deep/75">
        These controls act on this exact stored revision. Approval, application, and reversion are
        separate recorded actions.
      </p>

      {refreshedConflict ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
          <p className="text-sm text-amber-950">
            The current revision was refreshed after a conflict. Review its payload and validation
            evidence above before continuing.
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-950"
            onClick={() => {
              setRefreshedConflict(false)
              setError(null)
            }}
          >
            I reviewed the refreshed revision
          </button>
        </div>
      ) : null}

      {selectionUnavailable ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          No lifecycle controls are available for this selection. Return to package history and
          choose a current package.
        </p>
      ) : availableAction ? (
        <div className="mt-4 space-y-4">
          {!reviewComplete && availableAction !== 'revert' ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              Approval and application require error-free validation and a complete semantic scan.
            </p>
          ) : null}
          {availableAction === 'approve' && warningCount > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-950">Warnings requiring review</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                {visibleWarnings.map((warning) => (
                  <li key={`${warning.code}:${warning.path}`}>
                    <span className="font-mono text-xs">{warning.path}</span>: {warning.message}
                  </li>
                ))}
              </ul>
              {!allWarningsVisible ? (
                <div className="mt-3">
                  <p className="text-xs text-amber-900">
                    Showing 20 of {warningCount} warnings. Expand the complete list before
                    acknowledgement.
                  </p>
                  <button
                    type="button"
                    disabled={busy !== null || refreshedConflict}
                    onClick={() => setWarningsExpanded(true)}
                    className="mt-2 min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-sm font-semibold text-amber-950 disabled:opacity-50"
                  >
                    Show all {warningCount} warnings
                  </button>
                </div>
              ) : (
                <label className="mt-3 flex items-start gap-2 text-sm text-amber-950">
                  <input
                    type="checkbox"
                    checked={warningsAcknowledged}
                    disabled={busy !== null || refreshedConflict}
                    onChange={(event) => setWarningsAcknowledged(event.target.checked)}
                    className="mt-1"
                  />
                  I reviewed all {warningCount} warning{warningCount === 1 ? '' : 's'} for this
                  exact payload.
                </label>
              )}
            </div>
          ) : null}
          <label className="flex items-start gap-2 text-sm text-pf-deep/80">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy !== null || refreshedConflict}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1"
            />
            {availableAction === 'apply'
              ? 'I confirm that I reviewed this exact approved revision and intend to change venue content atomically.'
              : availableAction === 'revert'
                ? 'I confirm that I intend to revert every unchanged item created by this exact applied package.'
                : 'I confirm that I reviewed this exact revision and intend to approve it.'}
          </label>
          <button
            type="button"
            disabled={
              busy !== null ||
              refreshedConflict ||
              !confirmed ||
              (!reviewComplete && availableAction !== 'revert') ||
              (availableAction === 'approve' && warningCount > 0 && !warningsAcknowledged)
            }
            onClick={() => void runLifecycle(availableAction)}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === availableAction ? 'Recording action...' : actionLabel}
          </button>
        </div>
      ) : (
        <p className="mt-4 rounded-xl bg-pf-surface p-4 text-sm text-pf-deep/75">
          {current.status === 'REVERTED'
            ? 'This package has been reverted. No further lifecycle action is available.'
            : `No lifecycle action is available for status ${current.status}.`}
        </p>
      )}

      {error ? (
        <p className="mt-4 text-sm text-rose-800" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 text-sm text-emerald-800" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  )
}
