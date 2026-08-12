'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import {
  clearGenerationRequestAttempt,
  getOrCreateGenerationRequestAttempt,
  type GenerationRequestAttempt,
} from '../../lib/generation-request-idempotency'

type AdminGenerateWeeklyReportButtonProps = {
  tenantId: string
  venueId: string
  weekStart: string
  weekEnd: string
  enabled: boolean
  retrySeed?: string
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function AdminGenerateWeeklyReportButton({
  tenantId,
  venueId,
  weekStart,
  weekEnd,
  enabled,
  retrySeed,
}: AdminGenerateWeeklyReportButtonProps) {
  const router = useRouter()
  const client = useTRPCClient()

  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const attemptRef = useRef<GenerationRequestAttempt | null>(null)
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
    attemptRef.current = null
    setTitle('')
    setPending(false)
    setErrorMessage(null)
  }, [tenantId, venueId, weekStart, weekEnd, enabled, retrySeed])

  function isCurrentAction(action: { token: number; scope: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  async function handleClick() {
    if (activeAction.current !== null || !enabled) return
    const action = {
      token: ++actionSequence.current,
      scope: scopeGeneration.current,
    }
    activeAction.current = action.token
    setPending(true)
    setErrorMessage(null)

    const trimmedTitle = title.trim()
    const target = { tenantId, venueId, weekStart, weekEnd, trimmedTitle }
    const requestInput = {
      kind: 'weekly-report' as const,
      tenantId: target.tenantId,
      venueId: target.venueId,
      rangeStart: target.weekStart,
      rangeEnd: target.weekEnd,
      ...(target.trimmedTitle ? { title: target.trimmedTitle } : {}),
      ...(retrySeed ? { retrySeed } : {}),
    }

    try {
      const attempt = await getOrCreateGenerationRequestAttempt(requestInput, attemptRef.current)
      if (!isCurrentAction(action)) return
      attemptRef.current = attempt
      const result = await client.admin.generateWeeklyReportDraft.mutate({
        tenantId: target.tenantId,
        venueId: target.venueId,
        weekStart: target.weekStart,
        weekEnd: target.weekEnd,
        requestId: attempt.requestId,
        ...(target.trimmedTitle ? { title: target.trimmedTitle } : {}),
      })
      if (!isCurrentAction(action)) return
      clearGenerationRequestAttempt(requestInput, attempt)
      attemptRef.current = null
      router.push(
        `/admin/clients/${target.tenantId}/venues/${target.venueId}/reports/${result.reportId}`,
      )
    } catch (error) {
      if (!isCurrentAction(action)) return
      setErrorMessage(
        errorCode(error) === 'CONFLICT'
          ? 'This generation request conflicts with an existing request. Review the report inputs before retrying.'
          : 'The generation outcome could not be confirmed. Retry will reuse the same request identity.',
      )
    } finally {
      if (isCurrentAction(action)) {
        activeAction.current = null
        setPending(false)
      }
    }
  }

  return (
    <div className="space-y-3" aria-busy={pending}>
      <label className="grid gap-2 text-sm font-medium text-pf-deep">
        Title (optional)
        <input
          type="text"
          value={title}
          maxLength={200}
          disabled={pending || !enabled}
          onChange={(event) => {
            setTitle(event.target.value)
            setErrorMessage(null)
          }}
          placeholder="PathFinder Weekly Report"
          className="min-h-10 w-full max-w-md rounded-2xl border border-pf-light bg-pf-surface px-4 text-sm text-pf-deep outline-none transition focus:border-pf-primary disabled:opacity-60"
        />
      </label>
      <button
        type="button"
        disabled={pending || !enabled}
        onClick={() => void handleClick()}
        className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Queuing…' : enabled ? 'Generate Report Draft' : 'Enable Reports to Generate'}
      </button>
      {errorMessage ? (
        <p className="text-sm text-rose-600" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
