'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type NativeRelease = inferRouterOutputs<AppRouter>['admin']['getNativeVenueDeployment']
type NativeAction = 'approve' | 'apply' | 'revert'

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function label(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function NativeVenueDeploymentLifecycleControls({
  tenantId,
  venueId,
  initialRelease,
}: {
  tenantId: string
  venueId: string
  initialRelease: NativeRelease
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const scopeKey = `${tenantId}:${venueId}:${initialRelease.id}:${new Date(initialRelease.version).toISOString()}`
  const renderedScope = useRef(scopeKey)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const commandIds = useRef(new Map<string, string>())
  const resultHeading = useRef<HTMLHeadingElement>(null)
  const [readyScope, setReadyScope] = useState(scopeKey)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<NativeAction | null>(null)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    generation.current += 1
    inFlight.current = false
    commandIds.current.clear()
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
    commandIds.current.clear()
  }, [scopeKey])

  useEffect(() => {
    if (error || notice) resultHeading.current?.focus()
  }, [error, notice])

  const gates = initialRelease.allowedActions
  const action: NativeAction | null = gates.approve.allowed
    ? 'approve'
    : gates.apply.allowed
      ? 'apply'
      : gates.revert.allowed
        ? 'revert'
        : null
  const actionLabel =
    action === 'approve'
      ? 'Approve native release'
      : action === 'apply'
        ? 'Apply native release'
        : action === 'revert'
          ? 'Revert native release'
          : null

  async function run(selectedAction: NativeAction) {
    if (!scopeReady || locked || inFlight.current || selectedAction !== action || !confirmed) return
    inFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scopeKey
    const commandIdentity = `${initialRelease.id}:${initialRelease.version}:${selectedAction}`
    const commandId = commandIds.current.get(commandIdentity) ?? crypto.randomUUID()
    commandIds.current.set(commandIdentity, commandId)
    setBusy(selectedAction)
    setError(null)
    setNotice(null)
    try {
      const input = {
        tenantId,
        venueId,
        releaseId: initialRelease.id,
        commandId,
        expectedUpdatedAt: gates.expectedUpdatedAt,
      }
      const result =
        selectedAction === 'approve'
          ? await client.admin.approveNativeVenueDeployment.mutate(input)
          : selectedAction === 'apply'
            ? await client.admin.applyNativeVenueDeployment.mutate(input)
            : await client.admin.revertNativeVenueDeployment.mutate(input)
      if (generation.current !== startedGeneration || renderedScope.current !== startedScope) return
      setLocked(true)
      setConfirmed(false)
      setNotice(
        selectedAction === 'approve'
          ? 'Native release approved. Applying remains a separate action.'
          : selectedAction === 'apply'
            ? result.effectCount === null
              ? 'Native release applied atomically.'
              : `Native release applied atomically. ${result.effectCount} recorded effect${result.effectCount === 1 ? '' : 's'}.`
            : 'The release’s recorded mutable state was restored and inverse publication events were appended. Revert proceeds only while the exact applied evidence is unchanged; immutable revision history remains.',
      )
      router.refresh()
    } catch (cause) {
      if (generation.current !== startedGeneration || renderedScope.current !== startedScope) return
      const code = errorCode(cause)
      if (code === 'NOT_FOUND') {
        commandIds.current.delete(commandIdentity)
        setLocked(true)
        setError('This native release is no longer available in the selected client and venue.')
      } else if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'BAD_REQUEST') {
        commandIds.current.delete(commandIdentity)
        setLocked(true)
        setError(
          'The native release or venue state changed. Reload and review the authoritative release before continuing.',
        )
        router.refresh()
      } else {
        setError(
          'The native release action could not be confirmed. Retry is safe and will use the same command identity for this unchanged release.',
        )
      }
    } finally {
      if (generation.current === startedGeneration && renderedScope.current === startedScope) {
        inFlight.current = false
        setBusy(null)
      }
    }
  }

  return (
    <section
      aria-labelledby="native-lifecycle-heading"
      aria-busy={busy !== null}
      className="rounded-2xl border border-pf-light bg-white p-5"
    >
      <h4 id="native-lifecycle-heading" className="font-semibold text-pf-deep">
        Native release lifecycle
      </h4>
      <p className="mt-2 text-sm leading-6 text-pf-deep/75">
        Approval, application, and reversion are separate recorded actions against this exact
        NATIVE_CORE_V1 release version.
      </p>

      {action ? (
        <div className="mt-4 space-y-4">
          <label className="flex items-start gap-2 text-sm text-pf-deep/80">
            <input
              type="checkbox"
              checked={scopeReady && confirmed}
              disabled={!scopeReady || locked || busy !== null}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1"
            />
            {action === 'apply'
              ? 'I reviewed this exact approved native release and intend to apply its supported recorded changes atomically.'
              : action === 'revert'
                ? 'I intend to restore this release’s recorded mutable state and append inverse publication events. The action proceeds only if the exact applied evidence is unchanged; immutable revision history remains.'
                : 'I reviewed this exact native release and intend to approve it.'}
          </label>
          <button
            type="button"
            disabled={!scopeReady || locked || busy !== null || !confirmed}
            onClick={() => void run(action)}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === action ? 'Recording action…' : actionLabel}
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl bg-pf-surface p-4 text-sm text-pf-deep/75">
          <p>No native lifecycle action is available for {label(initialRelease.status)}.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {[gates.approve.reason, gates.apply.reason, gates.revert.reason]
              .filter((reason): reason is string => Boolean(reason))
              .map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
          </ul>
        </div>
      )}

      {error || notice ? (
        <div className="mt-4" role={error ? 'alert' : 'status'}>
          <h5 ref={resultHeading} tabIndex={-1} className="text-sm font-semibold text-pf-deep">
            {error ? 'Action needs attention' : 'Action recorded'}
          </h5>
          <p className={`mt-1 text-sm ${error ? 'text-rose-800' : 'text-emerald-800'}`}>
            {error ?? notice}
          </p>
        </div>
      ) : null}
    </section>
  )
}
