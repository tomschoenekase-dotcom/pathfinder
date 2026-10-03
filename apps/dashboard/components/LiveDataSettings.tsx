'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

import {
  GUEST_KNOWLEDGE_POLICY_WORDING,
  LIVE_DATA_KIND_REQUIREMENTS,
  LIVE_DATA_LIMITS,
  LIVE_DATA_STATUS_VALUES,
  type LiveDataKind,
} from '@pathfinder/contracts/live-data'

import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'

const LIVE_DATA_LOAD_TIMEOUT_MS = 15_000

type KnowledgePolicy = {
  generalKnowledge: {
    mode: 'APPROVED_VENUE_ONLY' | 'ALLOWLISTED_GENERAL_BACKGROUND'
    allowedDomainCount: number
  }
  openWeb: { enabled: false; enablement: 'PLATFORM_ADMIN_ONLY'; implemented: false }
  liveConnectors: { activeCount: number; totalCount: number }
}

type ConnectorView = {
  id: string
  name: string
  kind: LiveDataKind
  provider: string
  resourceId: string
  resourceLabel: string
  endpointHost: string
  mapping: unknown
  pollIntervalSeconds: number
  freshnessBudgetSeconds: number
  enabled: boolean
  lastSuccessAt: Date | null
  lastErrorCategory: string | null
  consecutiveFailures: number
  lastTest: {
    at: Date
    outcome: string | null
    errorCategory: string | null
    preview: unknown
  } | null
  liveState: 'fresh' | 'stale' | 'unavailable' | 'unknown'
  observedAt: string | null
}

const KIND_LABEL: Record<LiveDataKind, string> = {
  sports_score: 'Game score',
  ride_status: 'Ride wait and status',
  generic_json: 'Other JSON feed',
}

const STATE_LABEL: Record<ConnectorView['liveState'], string> = {
  fresh: 'Fresh',
  stale: 'Stale: guide will not quote it',
  unavailable: 'Unavailable: guide will not quote it',
  unknown: 'No reading yet',
}

const ERROR_LABEL: Record<string, string> = {
  host_not_allowed: 'Host is not on the approved list',
  blocked_address: 'Address is not allowed',
  dns_failure: 'Host name did not resolve',
  timeout: 'Provider timed out',
  network_error: 'Network error',
  http_error: 'Provider returned an error',
  redirect_blocked: 'Redirect was blocked',
  payload_too_large: 'Response was too large',
  invalid_json: 'Response was not JSON',
  schema_invalid: 'A mapped value had the wrong type',
  missing_field: 'A required value was missing',
  invalid_timestamp: 'Provider time was not usable',
  rate_limited: 'Rate limited',
}

function describeError(category: string | null): string | null {
  return category ? (ERROR_LABEL[category] ?? category) : null
}

function when(value: Date | string | null): string {
  if (!value) return 'never'
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString()
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}

function mappingSummary(mapping: unknown): string[] {
  const fields = (mapping as { fields?: Record<string, { pointer: string }> } | null)?.fields
  return Object.entries(fields ?? {}).map(([key, field]) => `${key} ← ${field.pointer}`)
}

function parseStatusMap(text: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('=').map((part) => part.trim()))
    .filter((parts) => parts.length === 2 && parts[0] && parts[1]) as Array<[string, string]>
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

const inputClass =
  'mt-1 min-h-11 w-full rounded-2xl border border-pf-light bg-pf-white px-4 text-pf-deep outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20'
const buttonClass =
  'min-h-11 rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-deep transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50'

export function LiveDataSettings({ venueId }: { venueId: string }) {
  const client = useTRPCClient()
  const [policy, setPolicy] = useState<KnowledgePolicy | null>(null)
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const [kind, setKind] = useState<LiveDataKind>('sports_score')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [resourceLabel, setResourceLabel] = useState('')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [timezone, setTimezone] = useState('America/New_York')
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState<number>(
    LIVE_DATA_LIMITS.defaultPollIntervalSeconds,
  )
  const [freshnessBudgetSeconds, setFreshnessBudgetSeconds] = useState<number>(
    LIVE_DATA_LIMITS.defaultFreshnessBudgetSeconds,
  )
  const [pointers, setPointers] = useState<Record<string, string>>({})
  const [statusMapText, setStatusMapText] = useState('')
  const [observedAtPointer, setObservedAtPointer] = useState('')
  const [observedAtFormat, setObservedAtFormat] = useState<
    'iso8601' | 'epoch_seconds' | 'epoch_ms'
  >('iso8601')
  const [genericMapping, setGenericMapping] = useState(
    '{"fields":{"value":{"pointer":"/value","type":"text"}}}',
  )

  // Explicit invalidation: every successful mutation reloads this venue's policy and connectors.
  const reload = useCallback(
    async (parentSignal: AbortSignal) => {
      const [nextPolicy, nextConnectors] = await runBoundedClientRequest({
        parentSignal,
        timeoutMs: LIVE_DATA_LOAD_TIMEOUT_MS,
        request: (signal) =>
          Promise.all([
            client.liveData.policy.query({ venueId }, { signal }),
            client.liveData.list.query({ venueId }, { signal }),
          ]),
      })
      if (parentSignal.aborted) return
      setPolicy(nextPolicy as KnowledgePolicy)
      setConnectors(nextConnectors as unknown as ConnectorView[])
    },
    [client, venueId],
  )

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).catch((loadError) => {
      if (!controller.signal.aborted) setError(message(loadError))
    })
    return () => controller.abort()
  }, [reload])

  async function run(action: () => Promise<unknown>, success: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await reload(new AbortController().signal)
      setNotice(success)
    } catch (actionError) {
      setError(message(actionError))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function buildMapping() {
    if (kind === 'generic_json') return JSON.parse(genericMapping) as unknown
    const requirements = LIVE_DATA_KIND_REQUIREMENTS[kind]
    const fields: Record<string, unknown> = {}
    for (const [key, type] of [
      ...Object.entries(requirements.required),
      ...Object.entries(requirements.optional),
    ]) {
      const pointer = pointers[key]?.trim()
      if (!pointer) continue
      const statusMap = type === 'status' ? parseStatusMap(statusMapText) : undefined
      fields[key] = {
        pointer,
        type,
        ...(statusMap ? { statusMap } : {}),
        ...(key === 'waitMinutes' ? { unit: 'minutes' } : {}),
      }
    }
    return {
      ...(observedAtPointer.trim()
        ? { observedAt: { pointer: observedAtPointer.trim(), format: observedAtFormat } }
        : {}),
      fields,
    }
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(async () => {
      await client.liveData.create.mutate({
        venueId,
        name,
        kind,
        provider,
        resourceId,
        resourceLabel,
        endpointUrl,
        mapping: buildMapping() as never,
        pollIntervalSeconds,
        freshnessBudgetSeconds,
        timezone,
      })
      setName('')
      setResourceId('')
      setResourceLabel('')
      setEndpointUrl('')
    }, 'Live source added. It is off until you test it and turn it on.')
  }

  const requirements = LIVE_DATA_KIND_REQUIREMENTS[kind]
  const fieldKeys = [...Object.keys(requirements.required), ...Object.keys(requirements.optional)]

  return (
    <section
      aria-labelledby="live-data-heading"
      className="mt-6 space-y-6 rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
          Knowledge sources
        </p>
        <h2 id="live-data-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          What the guide may use, and live feeds
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          {GUEST_KNOWLEDGE_POLICY_WORDING}
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </p>
      ) : null}

      {policy ? (
        <dl className="grid gap-4 sm:grid-cols-3" aria-label="Knowledge policy for this venue">
          <div className="rounded-2xl border border-pf-light p-4">
            <dt className="text-sm font-semibold text-pf-deep">General knowledge</dt>
            <dd className="mt-1 text-sm text-pf-deep/75">
              {policy.generalKnowledge.mode === 'APPROVED_VENUE_ONLY'
                ? 'Approved venue content only.'
                : `Approved venue content, plus general background from ${policy.generalKnowledge.allowedDomainCount} approved site(s). Never venue facts.`}
            </dd>
          </div>
          <div className="rounded-2xl border border-pf-light p-4">
            <dt className="text-sm font-semibold text-pf-deep">Open web browsing</dt>
            <dd className="mt-1 text-sm text-pf-deep/75">
              Off. Turning it on would need a Torchiko platform admin, and it is not offered as a
              product.
            </dd>
          </div>
          <div className="rounded-2xl border border-pf-light p-4">
            <dt className="text-sm font-semibold text-pf-deep">Live connectors</dt>
            <dd className="mt-1 text-sm text-pf-deep/75">
              {policy.liveConnectors.activeCount} on, {policy.liveConnectors.totalCount} set up.
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-pf-deep">Live sources</h3>
        {connectors === null ? (
          <p className="text-sm text-pf-deep/70">Loading live sources.</p>
        ) : connectors.length === 0 ? (
          <p className="text-sm text-pf-deep/70">
            No live sources yet. The guide answers only from approved venue content.
          </p>
        ) : (
          <ul className="space-y-4">
            {connectors.map((connector) => (
              <li
                key={connector.id}
                className="rounded-2xl border border-pf-light p-4"
                data-testid={`live-connector-${connector.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-pf-deep">{connector.resourceLabel}</p>
                    <p className="text-xs text-pf-deep/65">
                      {KIND_LABEL[connector.kind]} from {connector.provider} via{' '}
                      {connector.endpointHost}
                    </p>
                  </div>
                  <span
                    className="rounded-full border border-pf-light px-3 py-1 text-xs font-semibold text-pf-deep"
                    data-state={connector.liveState}
                  >
                    {connector.enabled ? STATE_LABEL[connector.liveState] : 'Off'}
                  </span>
                </div>
                <ul className="mt-3 space-y-1 text-xs text-pf-deep/70" aria-label="Field mapping">
                  {mappingSummary(connector.mapping).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-pf-deep/70">
                  Checked every {connector.pollIntervalSeconds}s; a reading is quoted for up to{' '}
                  {connector.freshnessBudgetSeconds}s. Last success: {when(connector.lastSuccessAt)}
                  .
                  {connector.lastErrorCategory
                    ? ` Last problem: ${describeError(connector.lastErrorCategory)} (${connector.consecutiveFailures} in a row).`
                    : ''}
                </p>
                {connector.lastTest ? (
                  <p className="mt-1 text-xs text-pf-deep/70">
                    Last test {when(connector.lastTest.at)}:{' '}
                    {connector.lastTest.outcome === 'OK'
                      ? 'worked'
                      : `failed (${describeError(connector.lastTest.errorCategory) ?? 'unknown'})`}
                    .
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => client.liveData.test.mutate({ connectorId: connector.id }),
                        'Test queued. Refresh in a few seconds to see the result.',
                      )
                    }
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          connector.enabled
                            ? client.liveData.disable.mutate({ connectorId: connector.id })
                            : client.liveData.enable.mutate({ connectorId: connector.id }),
                        connector.enabled ? 'Live source turned off.' : 'Live source turned on.',
                      )
                    }
                  >
                    {connector.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={handleCreate} className="space-y-4" aria-busy={busy}>
        <h3 className="text-lg font-semibold text-pf-deep">Add a live source</h3>
        <p className="text-sm text-pf-deep/70">
          Read-only HTTPS feeds on hosts Torchiko has approved. Do not put keys or passwords in the
          address. New sources start off.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-pf-deep">
            Kind
            <select
              className={inputClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as LiveDataKind)}
            >
              {(Object.keys(KIND_LABEL) as LiveDataKind[]).map((key) => (
                <option key={key} value={key}>
                  {KIND_LABEL[key]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Name
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Provider
            <input
              className={inputClass}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            What visitors call it
            <input
              className={inputClass}
              value={resourceLabel}
              onChange={(e) => setResourceLabel(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Resource ID (for example game.home or ride.coaster)
            <input
              className={inputClass}
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              required
              maxLength={80}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Time zone
            <input
              className={inputClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep sm:col-span-2">
            Feed address (https)
            <input
              className={inputClass}
              type="url"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              required
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Check every (seconds)
            <input
              className={inputClass}
              type="number"
              min={LIVE_DATA_LIMITS.minPollIntervalSeconds}
              max={LIVE_DATA_LIMITS.maxPollIntervalSeconds}
              value={pollIntervalSeconds}
              onChange={(e) => setPollIntervalSeconds(Number(e.target.value))}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Quote a reading for up to (seconds)
            <input
              className={inputClass}
              type="number"
              min={LIVE_DATA_LIMITS.minFreshnessBudgetSeconds}
              max={LIVE_DATA_LIMITS.maxFreshnessBudgetSeconds}
              value={freshnessBudgetSeconds}
              onChange={(e) => setFreshnessBudgetSeconds(Number(e.target.value))}
            />
          </label>
        </div>

        {kind === 'generic_json' ? (
          <label className="block text-sm font-semibold text-pf-deep">
            Mapping (JSON)
            <textarea
              className={`${inputClass} min-h-32 py-3 font-mono text-xs`}
              value={genericMapping}
              onChange={(e) => setGenericMapping(e.target.value)}
            />
          </label>
        ) : (
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-pf-deep">
              Where each value is in the feed (JSON pointer, for example /game/home/score)
            </legend>
            {fieldKeys.map((key) => (
              <label key={key} className="block text-sm text-pf-deep">
                {key}
                {key in requirements.required ? ' (required)' : ''}
                <input
                  className={inputClass}
                  value={pointers[key] ?? ''}
                  onChange={(e) =>
                    setPointers((current) => ({ ...current, [key]: e.target.value }))
                  }
                  required={key in requirements.required}
                  placeholder="/path/to/value"
                />
              </label>
            ))}
            {fieldKeys.includes('status') ? (
              <label className="block text-sm text-pf-deep">
                Status words, one per line as provider value = {LIVE_DATA_STATUS_VALUES.join(' | ')}
                <textarea
                  className={`${inputClass} min-h-20 py-3 font-mono text-xs`}
                  value={statusMapText}
                  onChange={(e) => setStatusMapText(e.target.value)}
                  placeholder={
                    kind === 'ride_status' ? 'true = open\nfalse = down' : 'LIVE = in_progress'
                  }
                />
              </label>
            ) : null}
            <label className="block text-sm text-pf-deep">
              Provider timestamp (optional, strongly recommended)
              <input
                className={inputClass}
                value={observedAtPointer}
                onChange={(e) => setObservedAtPointer(e.target.value)}
                placeholder="/updatedAt"
              />
            </label>
            <label className="block text-sm text-pf-deep">
              Timestamp format
              <select
                className={inputClass}
                value={observedAtFormat}
                onChange={(e) => setObservedAtFormat(e.target.value as typeof observedAtFormat)}
              >
                <option value="iso8601">ISO 8601 text</option>
                <option value="epoch_seconds">Unix seconds</option>
                <option value="epoch_ms">Unix milliseconds</option>
              </select>
            </label>
          </fieldset>
        )}

        <button type="submit" className={buttonClass} disabled={busy}>
          Add live source
        </button>
      </form>
    </section>
  )
}
