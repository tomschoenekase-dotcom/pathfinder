'use client'

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const READ_TIMEOUT_MS = 15_000
const PAGE_SIZE = 20

type EventCursor = { id: string; createdAt: string } | null

type ActivationEvent = {
  id: string
  kind: string
  eventHash: string
  reason: string
  createdBy: string
  createdAt: Date | string
  approvalDecisionId: string | null
  promotionAssessmentId: string | null
}

type Head = {
  registryKey: string
  revision: number
  selectedRunCount: number
  activeVersion: {
    id: string
    version: number
    contentHash: string
    requiredToolCapabilities: string[]
  } | null
  activationEvent: ActivationEvent | null
}

type HistoryEvent = ActivationEvent & {
  registryKey: string
  priorVersionId: string | null
  resultingVersionId: string | null
  priorRevision: number
  resultingRevision: number
}

export type AgentWorkflowActivationLedgerPage = {
  heads: Head[]
  events: HistoryEvent[]
  nextHeadAfterRegistryKey: string | null
  nextEventBefore: EventCursor
}

function displayDate(value: Date | string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? 'Recorded time unavailable'
    : `${date.toLocaleString('en-US', { timeZone: 'UTC' })} UTC`
}

function mergeUnique<T>(prior: T[], next: T[], key: (value: T) => string) {
  const known = new Set(prior.map(key))
  return [...prior, ...next.filter((value) => !known.has(key(value)))]
}

function HeadStatus({ head }: { head: Head }) {
  if (head.activeVersion) {
    return (
      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-900">
        Active version recorded
      </span>
    )
  }
  if (head.activationEvent?.kind === 'REVOKE') {
    return (
      <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-900">
        Revoked
      </span>
    )
  }
  return (
    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
      No active version recorded
    </span>
  )
}

export function AgentWorkflowActivationLedger({
  tenantId,
  venueId,
  initialPage,
}: {
  tenantId: string
  venueId: string
  initialPage: AgentWorkflowActivationLedgerPage
}) {
  const client = useTRPCClient()
  const scope = JSON.stringify([tenantId, venueId])
  const renderedScope = useRef(scope)
  const generation = useRef(0)
  const mounted = useRef(true)
  const headAbort = useRef<AbortController | null>(null)
  const eventAbort = useRef<AbortController | null>(null)
  const headInFlight = useRef(false)
  const eventInFlight = useRef(false)
  const [readyScope, setReadyScope] = useState(scope)
  const [heads, setHeads] = useState(initialPage.heads)
  const [events, setEvents] = useState(initialPage.events)
  const [headCursor, setHeadCursor] = useState(initialPage.nextHeadAfterRegistryKey)
  const [eventCursor, setEventCursor] = useState<EventCursor>(initialPage.nextEventBefore)
  const [headLoading, setHeadLoading] = useState(false)
  const [eventLoading, setEventLoading] = useState(false)
  const [headError, setHeadError] = useState<string | null>(null)
  const [eventError, setEventError] = useState<string | null>(null)

  if (renderedScope.current !== scope) {
    renderedScope.current = scope
    generation.current += 1
    headInFlight.current = false
    eventInFlight.current = false
  }

  useEffect(() => {
    mounted.current = true
    headAbort.current?.abort()
    eventAbort.current?.abort()
    headAbort.current = null
    eventAbort.current = null
    generation.current += 1
    setReadyScope(scope)
    setHeads(initialPage.heads)
    setEvents(initialPage.events)
    setHeadCursor(initialPage.nextHeadAfterRegistryKey)
    setEventCursor(initialPage.nextEventBefore)
    setHeadLoading(false)
    setEventLoading(false)
    setHeadError(null)
    setEventError(null)
    headInFlight.current = false
    eventInFlight.current = false
    return () => {
      mounted.current = false
      headAbort.current?.abort()
      eventAbort.current?.abort()
      headAbort.current = null
      eventAbort.current = null
      generation.current += 1
      headInFlight.current = false
      eventInFlight.current = false
    }
  }, [initialPage, scope])

  function current(startedGeneration: number, startedScope: string) {
    return (
      mounted.current &&
      generation.current === startedGeneration &&
      renderedScope.current === startedScope
    )
  }

  async function loadMoreHeads() {
    if (readyScope !== scope || !headCursor || headInFlight.current) return
    headInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const cursor = headCursor
    const controller = new AbortController()
    headAbort.current = controller
    setHeadLoading(true)
    setHeadError(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listAgentWorkflowActivations.query(
            { tenantId, venueId, limit: PAGE_SIZE, headAfterRegistryKey: cursor },
            { signal },
          ),
      })
      if (!current(startedGeneration, startedScope)) return
      setHeads((prior) => mergeUnique(prior, page.heads, (head) => head.registryKey))
      setHeadCursor(page.nextHeadAfterRegistryKey)
    } catch {
      if (current(startedGeneration, startedScope)) {
        setHeadError('Workflow heads could not be loaded. Existing entries were unchanged.')
      }
    } finally {
      if (headAbort.current === controller) headAbort.current = null
      if (current(startedGeneration, startedScope)) {
        headInFlight.current = false
        setHeadLoading(false)
      }
    }
  }

  async function loadMoreEvents() {
    if (readyScope !== scope || !eventCursor || eventInFlight.current) return
    eventInFlight.current = true
    const startedGeneration = generation.current
    const startedScope = scope
    const cursor = eventCursor
    const controller = new AbortController()
    eventAbort.current = controller
    setEventLoading(true)
    setEventError(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listAgentWorkflowActivations.query(
            { tenantId, venueId, limit: PAGE_SIZE, eventBefore: cursor },
            { signal },
          ),
      })
      if (!current(startedGeneration, startedScope)) return
      setEvents((prior) => mergeUnique(prior, page.events, (event) => event.id))
      setEventCursor(page.nextEventBefore)
    } catch {
      if (current(startedGeneration, startedScope)) {
        setEventError('Workflow history could not be loaded. Existing events were unchanged.')
      }
    } finally {
      if (eventAbort.current === controller) eventAbort.current = null
      if (current(startedGeneration, startedScope)) {
        eventInFlight.current = false
        setEventLoading(false)
      }
    }
  }

  if (readyScope !== scope) return <p role="status">Loading workflow records…</p>

  return (
    <section
      id="workflow-activations"
      className="space-y-5"
      aria-labelledby="workflow-activations-heading"
    >
      <div className="border-b border-pf-light pb-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Workflow records
        </p>
        <h3 id="workflow-activations-heading" className="mt-2 text-xl font-semibold text-pf-deep">
          Workflow activation ledger
        </h3>
        <p className="mt-1 max-w-4xl text-sm leading-6 text-pf-deep/75">
          Recorded heads and immutable lifecycle events for this venue. An active version here is a
          recorded head, not proof it is currently eligible: selection also depends on the clock,
          capability policy, canary policy, and capacity.
        </p>
      </div>

      <section
        aria-labelledby="workflow-heads-heading"
        aria-busy={headLoading}
        className="space-y-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h4 id="workflow-heads-heading" className="text-base font-semibold text-pf-deep">
              Recorded workflow heads
            </h4>
            <p className="text-sm text-pf-deep/75">
              The latest durable revision for each workflow registry key.
            </p>
          </div>
          <span className="text-sm font-semibold tabular-nums text-pf-deep/75">
            {heads.length} shown
          </span>
        </div>
        {heads.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light px-4 py-5 text-sm text-pf-deep/75">
            No workflow activation heads are recorded for this venue.
          </p>
        ) : (
          <ul className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white">
            {heads.map((head) => (
              <li key={head.registryKey} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-mono text-sm font-semibold text-pf-deep">
                      {head.registryKey}
                    </p>
                    <p className="mt-1 text-sm text-pf-deep/75">
                      Revision {head.revision} · selected {head.selectedRunCount} times
                    </p>
                  </div>
                  <HeadStatus head={head} />
                </div>
                {head.activeVersion ? (
                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <p className="text-pf-deep/70">
                      Version{' '}
                      <span className="font-semibold text-pf-deep">
                        {head.activeVersion.version}
                      </span>
                    </p>
                    <p className="min-w-0 text-pf-deep/70">
                      Content hash{' '}
                      <span className="break-all font-mono text-xs text-pf-deep">
                        {head.activeVersion.contentHash}
                      </span>
                    </p>
                    <div className="sm:col-span-2">
                      <p className="font-medium text-pf-deep/70">Required capabilities</p>
                      {head.activeVersion.requiredToolCapabilities.length ? (
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {head.activeVersion.requiredToolCapabilities.map((capability) => (
                            <li
                              key={capability}
                              className="max-w-full break-all rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-800"
                            >
                              {capability}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-pf-deep/75">
                          No required tool capabilities recorded.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
                {head.activationEvent ? (
                  <p className="mt-4 break-words border-t border-pf-light pt-3 text-sm leading-6 text-pf-deep/70">
                    Latest {head.activationEvent.kind.toLowerCase()} by{' '}
                    {head.activationEvent.createdBy} on{' '}
                    {displayDate(head.activationEvent.createdAt)}: {head.activationEvent.reason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {headError ? (
          <p role="alert" className="text-sm text-rose-700">
            {headError}
          </p>
        ) : null}
        {headCursor ? (
          <button
            type="button"
            onClick={() => void loadMoreHeads()}
            disabled={headLoading}
            className="min-h-11 rounded-xl border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {headLoading ? 'Loading workflow heads…' : 'Load more workflow heads'}
          </button>
        ) : null}
      </section>

      <section
        aria-labelledby="workflow-events-heading"
        aria-busy={eventLoading}
        className="space-y-3 border-t border-pf-light pt-5"
      >
        <div>
          <h4 id="workflow-events-heading" className="text-base font-semibold text-pf-deep">
            Immutable event history
          </h4>
          <p className="text-sm text-pf-deep/75">
            Lifecycle events are ordered newest first and remain separate from the current head.
          </p>
        </div>
        {events.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light px-4 py-5 text-sm text-pf-deep/75">
            No workflow lifecycle events are recorded for this venue.
          </p>
        ) : (
          <ol className="divide-y divide-pf-light rounded-2xl border border-pf-light bg-white">
            {events.map((event) => (
              <li key={event.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 break-all font-mono text-sm font-semibold text-pf-deep">
                    {event.registryKey}
                  </p>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
                    {event.kind}
                  </span>
                </div>
                <p className="mt-2 text-sm text-pf-deep/70">
                  Revision {event.priorRevision} → {event.resultingRevision} · {event.createdBy} ·{' '}
                  {displayDate(event.createdAt)}
                </p>
                <p className="mt-2 break-words text-sm leading-6 text-pf-deep/80">{event.reason}</p>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-xs text-pf-deep/75 sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold">Event hash</dt>
                    <dd className="break-all font-mono">{event.eventHash}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Version transition</dt>
                    <dd className="break-all font-mono">
                      {event.priorVersionId ?? 'none'} → {event.resultingVersionId ?? 'none'}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )}
        {eventError ? (
          <p role="alert" className="text-sm text-rose-700">
            {eventError}
          </p>
        ) : null}
        {eventCursor ? (
          <button
            type="button"
            onClick={() => void loadMoreEvents()}
            disabled={eventLoading}
            className="min-h-11 rounded-xl border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {eventLoading ? 'Loading older workflow events…' : 'Load older workflow events'}
          </button>
        ) : null}
      </section>
    </section>
  )
}
