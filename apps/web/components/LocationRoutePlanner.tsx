'use client'

import React, { type FormEvent, useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../lib/trpc'

type RouterOutputs = inferRouterOutputs<AppRouter>
type LocationCatalog = RouterOutputs['location']['catalog']['locations']
type LocationRoute = RouterOutputs['location']['route']

function connectionLabel(kind: string) {
  return kind.toLowerCase().replaceAll('_', ' ')
}

export function LocationRoutePlanner({
  venueId,
  anonymousToken,
  disabled = false,
}: {
  venueId: string
  anonymousToken: string | null
  disabled?: boolean
}) {
  const client = useTRPCClient()
  const requestGeneration = useRef(0)
  const [locations, setLocations] = useState<LocationCatalog | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [fromLocationId, setFromLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [accessibleOnly, setAccessibleOnly] = useState(false)
  const [route, setRoute] = useState<LocationRoute | null>(null)
  const [isRouting, setIsRouting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const generation = ++requestGeneration.current
    setLocations(null)
    setExpanded(false)
    setRoute(null)
    setError(null)
    if (!anonymousToken) return

    void client.location.catalog
      .query({ venueId, anonymousToken })
      .then((result) => {
        if (generation !== requestGeneration.current) return
        setLocations(result.locations)
        setFromLocationId(result.locations[0]?.id ?? '')
        setToLocationId(result.locations[1]?.id ?? '')
      })
      .catch(() => {
        // A missing entitlement and an unavailable catalog are both deliberately non-disclosing.
        if (generation === requestGeneration.current) setLocations([])
      })

    return () => {
      requestGeneration.current += 1
    }
  }, [anonymousToken, client, venueId])

  if (!anonymousToken || !locations || locations.length < 2) return null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!anonymousToken || !fromLocationId || !toLocationId || fromLocationId === toLocationId)
      return
    const generation = ++requestGeneration.current
    setIsRouting(true)
    setRoute(null)
    setError(null)
    try {
      const result = await client.location.route.query({
        venueId,
        anonymousToken,
        fromLocationId,
        toLocationId,
        accessibleOnly,
      })
      if (generation === requestGeneration.current) setRoute(result)
    } catch {
      if (generation === requestGeneration.current)
        setError(
          accessibleOnly
            ? 'No reviewed accessible route is available between those locations.'
            : 'No reviewed route is available between those locations.',
        )
    } finally {
      if (generation === requestGeneration.current) setIsRouting(false)
    }
  }

  return (
    <section className="mb-3 rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] text-[var(--chat-text)]">
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        disabled={disabled}
      >
        <span>Plan a route</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? (
        <form
          className="border-t border-[var(--chat-border)] px-4 pb-4 pt-3"
          onSubmit={handleSubmit}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-[var(--chat-text-muted)]">
              Start
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] px-3 text-sm text-[var(--chat-text)]"
                value={fromLocationId}
                onChange={(event) => {
                  setFromLocationId(event.target.value)
                  setRoute(null)
                  setError(null)
                }}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.displayName}
                    {location.floor ? ` — ${location.floor.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-[var(--chat-text-muted)]">
              Destination
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] px-3 text-sm text-[var(--chat-text)]"
                value={toLocationId}
                onChange={(event) => {
                  setToLocationId(event.target.value)
                  setRoute(null)
                  setError(null)
                }}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.displayName}
                    {location.floor ? ` — ${location.floor.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={accessibleOnly}
              onChange={(event) => {
                setAccessibleOnly(event.target.checked)
                setRoute(null)
                setError(null)
              }}
            />
            Use only connections marked accessible
          </label>
          <button
            type="submit"
            className="mt-2 min-h-11 w-full rounded-xl bg-[var(--chat-accent)] px-4 text-sm font-semibold text-[var(--chat-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || isRouting || fromLocationId === toLocationId}
          >
            {isRouting ? 'Finding route…' : 'Find route'}
          </button>
          {fromLocationId === toLocationId ? (
            <p className="mt-2 text-sm text-[var(--chat-text-muted)]" role="status">
              Choose two different locations.
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-[var(--chat-text)]" role="alert">
              {error}
            </p>
          ) : null}
          {route ? (
            <div className="mt-4" aria-live="polite">
              <p className="text-sm font-semibold">
                {route.from.displayName} to {route.to.displayName}
              </p>
              {route.accessibleOnly ? (
                <p className="mt-1 text-xs text-[var(--chat-text-muted)]">
                  Uses only connections the venue marked accessible. Confirm critical access needs
                  with venue staff.
                </p>
              ) : null}
              <ol className="mt-3 space-y-2">
                {route.segments.map((segment, index) => (
                  <li
                    key={`${segment.connectionId}:${index}`}
                    className="rounded-xl border border-[var(--chat-border)] bg-[var(--chat-surface)] p-3 text-sm"
                  >
                    <span className="font-semibold">{index + 1}. </span>
                    {segment.directions ??
                      `Continue to ${segment.to.displayName} via ${connectionLabel(segment.kind)}.`}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  )
}
