'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type GlobalAiIncidentControlProps = {
  initialState: {
    paused: boolean
    reason: string | null
    configured: boolean
    malformed: boolean
    updatedAt: string | null
    updatedBy: string | null
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

type Feedback = { kind: 'error' | 'success'; text: string }

export function GlobalAiIncidentControl({ initialState }: GlobalAiIncidentControlProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const {
    configured: initialConfigured,
    malformed: initialMalformed,
    paused: initialPaused,
    reason: initialReason,
    updatedAt: initialUpdatedAt,
    updatedBy: initialUpdatedBy,
  } = initialState
  const [state, setState] = useState(initialState)
  const [reason, setReason] = useState(initialState.reason ?? '')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
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
    setState({
      configured: initialConfigured,
      malformed: initialMalformed,
      paused: initialPaused,
      reason: initialReason,
      updatedAt: initialUpdatedAt,
      updatedBy: initialUpdatedBy,
    })
    setReason(initialReason ?? '')
    setPending(false)
    setFeedback(null)
  }, [
    initialConfigured,
    initialMalformed,
    initialPaused,
    initialReason,
    initialUpdatedAt,
    initialUpdatedBy,
  ])

  function startAction(): { scope: number; token: number } | null {
    if (activeAction.current !== null) return null
    const token = ++actionSequence.current
    activeAction.current = token
    setPending(true)
    return { scope: scopeGeneration.current, token }
  }

  function isCurrentAction(action: { scope: number; token: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finishAction(action: { scope: number; token: number }) {
    if (!isCurrentAction(action)) return
    activeAction.current = null
    setPending(false)
  }

  async function updateControl() {
    const normalizedReason = reason.trim()
    if (!normalizedReason) {
      setFeedback({
        kind: 'error',
        text: 'Enter an internal reason before changing the platform control.',
      })
      return
    }

    const action = startAction()
    if (!action) return
    const targetState = state
    setFeedback(null)
    try {
      const nextPaused = targetState.malformed ? true : !targetState.paused
      const result = await client.admin.setGlobalAiControl.mutate({
        paused: nextPaused,
        reason: normalizedReason,
        expectedUpdatedAt: targetState.updatedAt ? new Date(targetState.updatedAt) : null,
      })
      if (!isCurrentAction(action)) return
      setState({
        paused: result.paused,
        reason: result.reason,
        configured: result.configured,
        malformed: result.malformed,
        updatedAt: result.updatedAt?.toISOString() ?? null,
        updatedBy: result.updatedBy,
      })
      setReason(result.reason ?? '')
      setFeedback({
        kind: 'success',
        text: result.paused ? 'Global AI processing paused.' : 'Global AI processing resumed.',
      })
      router.refresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'The global AI control changed in another session. Reloading authoritative state; review it before retrying.'
            : 'The global AI control update could not be confirmed. Reloading authoritative state; review it before retrying.',
      })
      // A CAS conflict means the rendered revision is stale. Refresh on every failed write so
      // the next action is based on authoritative server state rather than a rejected snapshot.
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  const statusLabel = state.malformed ? 'Fail-closed' : state.paused ? 'Paused' : 'Active'

  return (
    <section
      className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
            Platform incident control
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Global AI</h2>
          <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">
            Stops new AI provider work and safely delays retained AI jobs. Health checks, admin
            access, email, and deterministic rollups remain available.
          </p>
        </div>
        <span
          className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${
            state.paused || state.malformed
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {state.malformed ? (
        <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          The stored control is malformed, so AI is denied until an administrator writes a valid
          state here.
        </p>
      ) : null}

      <label className="mt-5 block text-sm font-medium text-pf-deep" htmlFor="global-ai-reason">
        Internal reason
      </label>
      <textarea
        id="global-ai-reason"
        value={reason}
        maxLength={500}
        rows={2}
        disabled={pending}
        onChange={(event) => {
          if (activeAction.current !== null) return
          setReason(event.target.value)
        }}
        placeholder={state.paused ? 'Describe why AI can safely resume' : 'Describe the incident'}
        className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent"
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || reason.trim().length === 0}
          onClick={() => void updateControl()}
          className={`inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
            state.paused ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-rose-700 hover:bg-rose-800'
          }`}
        >
          {pending
            ? 'Saving...'
            : state.malformed
              ? 'Repair as paused'
              : state.paused
                ? 'Resume all AI'
                : 'Pause all AI'}
        </button>
        <p className="text-xs text-pf-deep/50">
          {state.updatedAt
            ? `Last changed ${new Date(state.updatedAt).toLocaleString()}${state.updatedBy ? ` by ${state.updatedBy}` : ''}`
            : 'Using the default active state; no control change has been recorded.'}
        </p>
      </div>

      {feedback ? (
        <p
          className="mt-3 text-sm text-pf-deep/70"
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}
