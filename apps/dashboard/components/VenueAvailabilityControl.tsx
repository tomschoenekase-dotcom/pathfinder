'use client'

import { useEffect, useState } from 'react'
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

export function VenueAvailabilityControl(props: VenueAvailabilityControlProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const [state, setState] = useState(props.initialState)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setState(props.initialState)
  }, [props.initialState])

  async function changeAvailability() {
    const normalizedReason = reason.trim()
    if (!normalizedReason) {
      setMessage('Enter an internal reason before changing venue availability.')
      return
    }

    const enabling = !state.isActive
    const confirmed = window.confirm(
      enabling
        ? `Resume guest access and venue-scoped processing for ${props.venueName}?`
        : `Pause guest access and venue-scoped processing for ${props.venueName}?`,
    )
    if (!confirmed) return

    setPending(true)
    setMessage(null)
    try {
      const commonInput = {
        venueId: props.venueId,
        enabled: enabling,
        expectedUpdatedAt: new Date(state.updatedAt),
        reason: normalizedReason,
      }
      const result =
        props.scope === 'admin'
          ? await client.admin.setVenueAvailability.mutate({
              ...commonInput,
              tenantId: props.tenantId,
            })
          : await client.venue.setAvailability.mutate(commonInput)

      setState({
        isActive: result.isActive,
        updatedAt: result.updatedAt.toISOString(),
      })
      setReason('')
      setMessage(
        result.isActive
          ? 'Venue access and processing resumed.'
          : 'Venue access and processing paused.',
      )
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to change venue availability.')
      // Refresh authoritative state after a stale-revision conflict or any uncertain write.
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
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
        onChange={(event) => setReason(event.target.value)}
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
          Revision from {new Date(state.updatedAt).toLocaleString()}
        </p>
      </div>

      {message ? (
        <p className="mt-3 text-sm text-pf-deep/70" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  )
}
