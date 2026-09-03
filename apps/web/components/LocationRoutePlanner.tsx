'use client'

import React, { type FormEvent, useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

type RouterOutputs = inferRouterOutputs<AppRouter>
type LocationCatalog = RouterOutputs['location']['catalog']['locations']
type LocationRoute = RouterOutputs['location']['route']

export type LocationRoutePlannerDataSource = {
  catalog: (
    input: { venueId: string; anonymousToken: string },
    signal: AbortSignal,
  ) => Promise<{
    locations: LocationCatalog
  }>
  route: (
    input: {
      venueId: string
      anonymousToken: string
      fromLocationId: string
      toLocationId: string
      accessibleOnly: boolean
    },
    signal: AbortSignal,
  ) => Promise<LocationRoute>
}

const LOCATION_READ_TIMEOUT_MS = 15_000

function connectionLabel(kind: string) {
  return kind.toLowerCase().replaceAll('_', ' ')
}

export function LocationRoutePlanner({
  venueId,
  anonymousToken,
  disabled = false,
  dataSource,
  language = 'English',
}: {
  venueId: string
  anonymousToken: string | null
  disabled?: boolean
  dataSource?: LocationRoutePlannerDataSource
  language?: SupportedChatLanguage
}) {
  const { route: copy } = getVisitorUiCopy(language)
  const [
    toggleLabel,
    startLabel,
    destinationLabel,
    accessibleOnlyLabel,
    findingLabel,
    findLabel,
    chooseDifferentLabel,
    noAccessibleRouteMessage,
    noRouteMessage,
    accessibleNote,
    reviewedRouteLabel,
    partialGuidanceMessage,
    equivalentRouteMessage,
    continueTo,
  ] = copy
  const presentation = getChatLanguagePresentation(language)
  const client = useTRPCClient()
  const requestGeneration = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const [locations, setLocations] = useState<LocationCatalog | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [fromLocationId, setFromLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [accessibleOnly, setAccessibleOnly] = useState(false)
  const [route, setRoute] = useState<LocationRoute | null>(null)
  const [isRouting, setIsRouting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    const generation = ++requestGeneration.current
    setLocations(null)
    setExpanded(false)
    setRoute(null)
    setError(null)
    if (!anonymousToken) {
      activeRequest.current = null
      return
    }

    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: LOCATION_READ_TIMEOUT_MS,
      request: (signal) =>
        dataSource
          ? dataSource.catalog({ venueId, anonymousToken }, signal)
          : client.location.catalog.query({ venueId, anonymousToken }, { signal }),
    })
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
      .finally(() => {
        if (activeRequest.current === controller) activeRequest.current = null
      })

    return () => {
      controller.abort()
      requestGeneration.current += 1
    }
  }, [anonymousToken, client, dataSource, venueId])

  if (!anonymousToken || !locations || locations.length < 2) return null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!anonymousToken || !fromLocationId || !toLocationId || fromLocationId === toLocationId)
      return
    const generation = ++requestGeneration.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setIsRouting(true)
    setRoute(null)
    setError(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: LOCATION_READ_TIMEOUT_MS,
        request: (signal) =>
          dataSource
            ? dataSource.route(
                { venueId, anonymousToken, fromLocationId, toLocationId, accessibleOnly },
                signal,
              )
            : client.location.route.query(
                { venueId, anonymousToken, fromLocationId, toLocationId, accessibleOnly },
                { signal },
              ),
      })
      if (generation === requestGeneration.current) setRoute(result)
    } catch {
      if (generation === requestGeneration.current)
        setError(accessibleOnly ? noAccessibleRouteMessage : noRouteMessage)
    } finally {
      if (generation === requestGeneration.current) setIsRouting(false)
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  return (
    <section
      lang={presentation.code}
      dir={presentation.direction}
      className="mb-3 rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] text-[var(--chat-text)]"
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        disabled={disabled}
      >
        <span>{toggleLabel}</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? (
        <form
          className="max-h-[min(36rem,70svh)] overflow-y-auto border-t border-[var(--chat-border)] px-4 pb-4 pt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--chat-accent)]"
          onSubmit={handleSubmit}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-[var(--chat-text-muted)]">
              {startLabel}
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
              {destinationLabel}
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
            {accessibleOnlyLabel}
          </label>
          <button
            type="submit"
            className="mt-2 min-h-11 w-full rounded-xl bg-[var(--chat-accent)] px-4 text-sm font-semibold text-[var(--chat-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || isRouting || fromLocationId === toLocationId}
          >
            {isRouting ? findingLabel : findLabel}
          </button>
          {fromLocationId === toLocationId ? (
            <p className="mt-2 text-sm text-[var(--chat-text-muted)]" role="status">
              {chooseDifferentLabel}
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
                {language === 'English'
                  ? `${route.from.displayName} to ${route.to.displayName}`
                  : `${route.from.displayName} → ${route.to.displayName}`}
              </p>
              <p className="mt-1 text-xs text-[var(--chat-text-muted)]">{reviewedRouteLabel}</p>
              {route.accessibleOnly ? (
                <p className="mt-1 text-xs text-[var(--chat-text-muted)]">{accessibleNote}</p>
              ) : null}
              {route.guidanceConfidence === 'LIMITED' ? (
                <p className="mt-2 text-sm text-[var(--chat-text)]" role="status">
                  {partialGuidanceMessage}
                </p>
              ) : null}
              {route.hasEquivalentRoute ? (
                <p className="mt-2 text-xs text-[var(--chat-text-muted)]">
                  {equivalentRouteMessage}
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
                      continueTo(segment.to.displayName, connectionLabel(segment.kind))}
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
