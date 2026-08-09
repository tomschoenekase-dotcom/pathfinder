'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type AdminVenueReportConfigurationProps = {
  tenantId: string
  venueId: string
  enabled: boolean
  updatedAt: string | null
}

type Feedback = { kind: 'error' | 'success'; text: string }

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function AdminVenueReportConfiguration({
  tenantId,
  venueId,
  enabled: initialEnabled,
  updatedAt,
}: AdminVenueReportConfigurationProps) {
  const router = useRouter()
  const client = useTRPCClient()

  const [enabled, setEnabled] = useState(initialEnabled)
  const [revision, setRevision] = useState(updatedAt)
  const [pending, setPending] = useState<'update' | 'reload' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const actionSequence = useRef(0)
  const activeAction = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeAction.current = null
    }
  }, [])

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    activeAction.current = null
    setEnabled(initialEnabled)
    setRevision(updatedAt)
    setPending(null)
    setFeedback(null)
    setRequiresReload(false)
  }, [tenantId, venueId, initialEnabled, updatedAt])

  function startAction(kind: 'update' | 'reload') {
    if (activeAction.current !== null) return null
    const action = {
      token: ++actionSequence.current,
      scope: scopeGeneration.current,
    }
    activeAction.current = action.token
    setPending(kind)
    return action
  }

  function isCurrentAction(action: { token: number; scope: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finishAction(action: { token: number; scope: number }) {
    if (!isCurrentAction(action)) return
    activeAction.current = null
    setPending(null)
  }

  async function update(nextEnabled: boolean) {
    const action = startAction('update')
    if (!action) return
    const target = { tenantId, venueId, enabled: nextEnabled, revision }
    setFeedback(null)
    try {
      const result = await client.admin.updateVenueReportConfiguration.mutate({
        tenantId: target.tenantId,
        venueId: target.venueId,
        enabled: target.enabled,
        expectedUpdatedAt: target.revision ? new Date(target.revision) : null,
      })
      if (!isCurrentAction(action)) return
      setEnabled(result.enabled)
      setRevision(result.updatedAt?.toISOString() ?? null)
      setFeedback({ kind: 'success', text: 'Report availability updated.' })
      router.refresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'Report availability changed after this view loaded. Reload the configuration before trying again.'
            : 'The update outcome could not be confirmed. Reload the configuration before trying again.',
      })
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  async function reload() {
    const action = startAction('reload')
    if (!action) return
    setFeedback(null)
    try {
      const result = await client.admin.getVenueReportConfiguration.query({ tenantId, venueId })
      if (!isCurrentAction(action)) return
      setEnabled(result.enabled)
      setRevision(result.updatedAt?.toISOString() ?? null)
      setRequiresReload(false)
      setFeedback({ kind: 'success', text: 'Report availability reloaded.' })
    } catch {
      if (!isCurrentAction(action)) return
      setFeedback({
        kind: 'error',
        text: 'Report availability could not be reloaded. No further change was attempted.',
      })
    } finally {
      finishAction(action)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending !== null}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-pf-deep">Client report access</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Default-off. Disabling hides published reports and prevents new report requests without
            deleting report history.
          </p>
        </div>
        <button
          type="button"
          disabled={pending !== null || requiresReload}
          onClick={() => void update(!enabled)}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === 'update' ? 'Saving…' : enabled ? 'Disable Reports' : 'Enable Reports'}
        </button>
      </div>
      <p className="mt-3 text-sm font-medium text-pf-deep">
        Current state: {enabled ? 'Enabled' : 'Disabled'}
      </p>
      {requiresReload && pending === null ? (
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-3 inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
        >
          Reload configuration
        </button>
      ) : null}
      {pending === 'reload' ? (
        <p className="mt-3 text-sm text-pf-deep/60" role="status">
          Reloading configuration…
        </p>
      ) : null}
      {feedback ? (
        <p
          className={`mt-3 text-sm ${feedback.kind === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}
