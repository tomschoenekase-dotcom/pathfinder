'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useTRPCClient } from '../lib/trpc'

type VenueOption = { id: string; name: string }
type PlaceOption = { id: string; name: string }
type UpdateType =
  | 'GENERAL_NOTICE'
  | 'TEMPORARY_CLOSURE'
  | 'UNAVAILABLE_EXHIBIT'
  | 'CHANGED_HOURS'
  | 'MAINTENANCE'
  | 'SPECIAL_EVENT'
  | 'SOLD_OUT_ACTIVITY'
  | 'TEMPORARY_VENDOR_LOCATION'
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'

export type OperationalUpdateFormValue = {
  id: string
  venueId: string
  placeId: string | null
  updateType: UpdateType
  priority: Priority
  title: string
  body: string | null
  redirectTo: string | null
  startsAt: string
  expiresAt: string
  updatedAt: string
}

type Props = {
  venues: VenueOption[]
  initialUpdate?: OperationalUpdateFormValue
}

const updateTypes: { value: UpdateType; label: string }[] = [
  { value: 'GENERAL_NOTICE', label: 'General notice' },
  { value: 'TEMPORARY_CLOSURE', label: 'Temporary closure' },
  { value: 'UNAVAILABLE_EXHIBIT', label: 'Unavailable exhibit' },
  { value: 'CHANGED_HOURS', label: 'Changed hours' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'SPECIAL_EVENT', label: 'Special event' },
  { value: 'SOLD_OUT_ACTIVITY', label: 'Sold-out activity' },
  { value: 'TEMPORARY_VENDOR_LOCATION', label: 'Temporary vendor location' },
]

const fieldClass =
  'min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20 disabled:bg-pf-surface disabled:text-pf-deep/50'

function formatDateTimeLocal(value: Date | string) {
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'The update could not be saved. Please try again.'
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function mutationErrorMessage(error: unknown) {
  if (errorCode(error) === 'CONFLICT') {
    return 'This operational update changed in another session. Reload this draft before trying again.'
  }

  const message = errorMessage(error)
  return /conflict|changed|stale/i.test(message)
    ? `${message} Reload this draft before trying again.`
    : message
}

function severityFor(updateType: UpdateType): 'INFO' | 'WARNING' | 'CLOSURE' | 'REDIRECT' {
  if (updateType === 'TEMPORARY_CLOSURE' || updateType === 'UNAVAILABLE_EXHIBIT') return 'CLOSURE'
  if (
    updateType === 'CHANGED_HOURS' ||
    updateType === 'MAINTENANCE' ||
    updateType === 'SOLD_OUT_ACTIVITY'
  )
    return 'WARNING'
  if (updateType === 'TEMPORARY_VENDOR_LOCATION') return 'REDIRECT'
  return 'INFO'
}

export function OperationalUpdateForm({ venues, initialUpdate }: Props) {
  const router = useRouter()
  const client = useTRPCClient()

  const defaultStart = new Date()
  const defaultExpiry = new Date(defaultStart.getTime() + 4 * 60 * 60 * 1000)
  const [venueId, setVenueId] = useState(initialUpdate?.venueId ?? venues[0]?.id ?? '')
  const [placeId, setPlaceId] = useState(initialUpdate?.placeId ?? '')
  const [places, setPlaces] = useState<PlaceOption[]>([])
  const [placesLoading, setPlacesLoading] = useState(false)
  const [updateType, setUpdateType] = useState<UpdateType>(
    initialUpdate?.updateType ?? 'TEMPORARY_CLOSURE',
  )
  const [priority, setPriority] = useState<Priority>(initialUpdate?.priority ?? 'NORMAL')
  const [title, setTitle] = useState(initialUpdate?.title ?? '')
  const [body, setBody] = useState(initialUpdate?.body ?? '')
  const [redirectTo, setRedirectTo] = useState(initialUpdate?.redirectTo ?? '')
  const [startsAt, setStartsAt] = useState(
    formatDateTimeLocal(initialUpdate?.startsAt ?? defaultStart),
  )
  const [expiresAt, setExpiresAt] = useState(
    formatDateTimeLocal(initialUpdate?.expiresAt ?? defaultExpiry),
  )
  const [pendingAction, setPendingAction] = useState<'draft' | 'publish' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const isMountedRef = useRef(true)
  const mutationInFlightRef = useRef(false)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      mutationInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!venueId) {
      setPlaces([])
      return
    }
    setPlacesLoading(true)
    void client.place.list
      .query({ venueId })
      .then((rows) => {
        if (!cancelled) {
          setPlaces(rows.map((row) => ({ id: row.id, name: row.name })))
          setPlaceId((current) => (rows.some((row) => row.id === current) ? current : ''))
        }
      })
      .catch((error) => {
        if (!cancelled) setFormError(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setPlacesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, venueId])

  async function submit(action: 'draft' | 'publish') {
    if (mutationInFlightRef.current) return
    setFormError(null)
    const start = new Date(startsAt)
    const expiry = new Date(expiresAt)
    if (!title.trim()) {
      setFormError('Enter a title.')
      return
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(expiry.getTime()) || expiry <= start) {
      setFormError('Expiration must be later than the start time.')
      return
    }

    mutationInFlightRef.current = true
    setPendingAction(action)
    const values = {
      venueId,
      ...(placeId ? { placeId } : {}),
      updateType,
      severity: severityFor(updateType),
      priority,
      title: title.trim(),
      ...(body.trim() ? { body: body.trim() } : {}),
      ...(redirectTo.trim() ? { redirectTo: redirectTo.trim() } : {}),
      startsAt: start,
      expiresAt: expiry,
    }

    try {
      if (initialUpdate) {
        await client.operationalUpdate.update.mutate({
          id: initialUpdate.id,
          expectedUpdatedAt: new Date(initialUpdate.updatedAt),
          publish: action === 'publish',
          ...values,
        })
      } else {
        await client.operationalUpdate.create.mutate({
          ...values,
          publish: action === 'publish',
        })
      }

      if (isMountedRef.current) {
        router.push('/operational-updates')
        router.refresh()
      }
    } catch (error) {
      if (isMountedRef.current) {
        const message = mutationErrorMessage(error)
        setFormError(
          !initialUpdate && errorCode(error) !== 'CONFLICT'
            ? `${message} Save status may be unknown; check the updates list before trying again.`
            : message,
        )
      }
    } finally {
      mutationInFlightRef.current = false
      if (isMountedRef.current) setPendingAction(null)
    }
  }

  const isEditing = Boolean(initialUpdate)
  const isMutating = pendingAction !== null
  return (
    <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
      <div className="mb-6 space-y-2">
        <Link
          href="/operational-updates"
          className="text-sm font-medium text-pf-primary hover:text-pf-accent"
        >
          Back to operational updates
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">
          {isEditing ? 'Edit operational update' : 'New operational update'}
        </h1>
        <p className="text-sm leading-6 text-pf-deep/60">
          Save a draft for review or publish it when it is ready to affect guest guidance.
        </p>
      </div>

      <form
        aria-busy={isMutating}
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault()
          void submit('draft')
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Venue" htmlFor="update-venue">
            <select
              id="update-venue"
              disabled={isMutating}
              value={venueId}
              onChange={(event) => setVenueId(event.target.value)}
              className={fieldClass}
              required
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Affected location or exhibit" htmlFor="update-place">
            <select
              id="update-place"
              value={placeId}
              onChange={(event) => setPlaceId(event.target.value)}
              className={fieldClass}
              disabled={placesLoading || isMutating}
            >
              <option value="">Entire venue</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Update type" htmlFor="update-type">
            <select
              id="update-type"
              disabled={isMutating}
              value={updateType}
              onChange={(event) => setUpdateType(event.target.value as UpdateType)}
              className={fieldClass}
            >
              {updateTypes.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" htmlFor="update-priority">
            <select
              id="update-priority"
              disabled={isMutating}
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
              className={fieldClass}
            >
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </Field>
          <Field label="Starts" htmlFor="update-starts-at">
            <input
              id="update-starts-at"
              disabled={isMutating}
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className={fieldClass}
              required
            />
          </Field>
          <Field label="Expires" htmlFor="update-expires-at">
            <input
              id="update-expires-at"
              disabled={isMutating}
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className={fieldClass}
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Title" htmlFor="update-title">
              <input
                id="update-title"
                disabled={isMutating}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={60}
                className={fieldClass}
                required
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Details" htmlFor="update-body">
              <textarea
                id="update-body"
                disabled={isMutating}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={300}
                className={`${fieldClass} min-h-28 py-3`}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Redirect (optional)" htmlFor="update-redirect">
              <input
                id="update-redirect"
                disabled={isMutating}
                value={redirectTo}
                onChange={(event) => setRedirectTo(event.target.value)}
                placeholder="/alternate-location or https://..."
                maxLength={200}
                className={fieldClass}
              />
            </Field>
          </div>
        </div>

        {formError ? (
          <p
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pendingAction !== null || !venueId}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary disabled:opacity-50"
          >
            {pendingAction === 'draft' ? 'Saving...' : 'Save draft'}
          </button>
          <button
            type="button"
            onClick={() => void submit('publish')}
            disabled={pendingAction !== null || !venueId}
            className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pendingAction === 'publish' ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      </form>
    </section>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}
