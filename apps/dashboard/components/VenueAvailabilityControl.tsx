'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../lib/trpc'

type AvailabilityState = {
  isActive: boolean
  updatedAt: string
}

type VenueAvailabilityControlProps = {
  venueName: string
  venueId: string
  initialState: AvailabilityState
} & (
  | { scope: 'tenant' }
  | {
      scope: 'admin'
      tenantId: string
    }
)

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

type Feedback = { kind: 'error' | 'success'; text: string }

function formatRevisionTimestamp(value: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value))} UTC`
}

export function VenueAvailabilityControl(props: VenueAvailabilityControlProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const initialIsActive = props.initialState.isActive
  const initialUpdatedAt = props.initialState.updatedAt
  const scopeTenantId = props.scope === 'admin' ? props.tenantId : null
  const [state, setState] = useState(props.initialState)
  const [reason, setReason] = useState('')
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
    setState({ isActive: initialIsActive, updatedAt: initialUpdatedAt })
    setReason('')
    setPending(false)
    setFeedback(null)
  }, [
    initialIsActive,
    initialUpdatedAt,
    props.scope,
    props.venueId,
    props.venueName,
    scopeTenantId,
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

  async function changeAvailability() {
    const normalizedReason = reason.trim()
    if (!normalizedReason) {
      setFeedback({
        kind: 'error',
        text: 'Enter an internal reason before changing venue availability.',
      })
      return
    }

    const action = startAction()
    if (!action) return
    const targetState = state
    const targetProps = props
    const enabling = !targetState.isActive
    const confirmed = window.confirm(
      enabling
        ? `Resume guest access and venue-scoped processing for ${targetProps.venueName}?`
        : `Pause guest access and venue-scoped processing for ${targetProps.venueName}?`,
    )
    if (!confirmed) {
      finishAction(action)
      return
    }

    setFeedback(null)
    try {
      const commonInput = {
        venueId: targetProps.venueId,
        enabled: enabling,
        expectedUpdatedAt: new Date(targetState.updatedAt),
        reason: normalizedReason,
      }
      const result =
        targetProps.scope === 'admin'
          ? await client.admin.setVenueAvailability.mutate({
              ...commonInput,
              tenantId: targetProps.tenantId,
            })
          : await client.venue.setAvailability.mutate(commonInput)

      if (!isCurrentAction(action)) return
      setState({
        isActive: result.isActive,
        updatedAt: result.updatedAt.toISOString(),
      })
      setReason('')
      setFeedback({
        kind: 'success',
        text: result.isActive
          ? 'Venue access and processing resumed.'
          : 'Venue access and processing paused.',
      })
      router.refresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'Venue availability changed in another session. Reloading authoritative state; review it before retrying.'
            : 'The venue availability update could not be confirmed. Reloading authoritative state; review it before retrying.',
      })
      // Refresh authoritative state after a stale-revision conflict or any uncertain write.
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  return (
    <section
      className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-accent">
            Operational control
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
            Venue availability
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/60">
            Pausing stops guest access and new venue-scoped processing. Use this during an incident;
            venue content remains intact.
          </p>
        </div>
        <span
          className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${
            state.isActive
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {state.isActive ? 'Active' : 'Paused'}
        </span>
      </div>

      <label
        className="mt-5 block text-sm font-medium text-pf-deep"
        htmlFor={`venue-availability-reason-${props.venueId}`}
      >
        Internal reason
      </label>
      <textarea
        id={`venue-availability-reason-${props.venueId}`}
        value={reason}
        maxLength={500}
        rows={2}
        required
        disabled={pending}
        onChange={(event) => {
          if (activeAction.current !== null) return
          setReason(event.target.value)
        }}
        placeholder={
          state.isActive
            ? 'Describe why this venue must be paused'
            : 'Describe why service can safely resume'
        }
        className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-accent"
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || reason.trim().length === 0}
          onClick={() => void changeAvailability()}
          className={`inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
            state.isActive ? 'bg-rose-700 hover:bg-rose-800' : 'bg-emerald-700 hover:bg-emerald-800'
          }`}
        >
          {pending ? 'Saving...' : state.isActive ? 'Pause this venue' : 'Resume this venue'}
        </button>
        <p className="text-xs text-pf-deep/50">
          Revision from{' '}
          <time dateTime={state.updatedAt}>{formatRevisionTimestamp(state.updatedAt)}</time>
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
