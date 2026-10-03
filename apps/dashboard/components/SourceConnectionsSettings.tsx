'use client'

import { ZodError } from 'zod'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

import {
  SourceConnectionConfigSchema,
  type SourceConnectionConfig,
} from '@pathfinder/contracts/source-connections'

import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'

type Preview = {
  previewId: string
  previewHash: string
  configHash: string
  status: 'VALID' | 'REVIEW_REQUIRED'
  records: Array<{
    id: string
    kind: string
    title: string
    text: string
    startDate: string | null
    endDate: string | null
    showtimes: Array<{ startAt: string; endAt: string }>
    links: string[]
    cancelled?: boolean
    exceptions?: string[]
  }>
  issues: string[]
  observedAt: string
  cost?: { fetches: number; bytes: number }
  usage?: {
    day: string
    requests: number
    bytes: number
    llmTokens: number
    llmCostUsd: number
    networkCost: string
  }
}
type SourceView = {
  id: string
  name: string
  venueId: string
  updatedAt: Date | string
  state: 'ACTIVE' | 'DISABLED' | 'INVALID_CONFIG'
  config: SourceConnectionConfig | null
  approved?: boolean
  preview: unknown
  previewAt?: Date | string | null
  previewOutcome?: string | null
  previewErrorCategory?: string | null
  snapshot?: unknown
  snapshotFetchedAt?: Date | string | null
  lastAttemptAt: Date | string | null
  lastSuccessAt: Date | string | null
  lastErrorAt: Date | string | null
  lastErrorCategory: string | null
  consecutiveFailures: number
}

const inputClass =
  'mt-1 min-h-11 w-full rounded-2xl border border-pf-light bg-white px-4 text-pf-deep outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20'
const buttonClass =
  'min-h-11 rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-deep transition hover:border-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent disabled:cursor-not-allowed disabled:opacity-50'

function errorText(error: unknown) {
  if (error instanceof ZodError)
    return error.issues
      .map(
        (issue) =>
          `${issue.path[0] === 'timezone' ? 'Time zone' : issue.path[0] === 'allowedUrls' ? 'Approved URLs' : 'Source setup'}: ${issue.message}`,
      )
      .join('. ')
  if (error instanceof SyntaxError)
    return 'The full configuration is not valid JSON. Correct it or clear it to use the simple fields.'
  return error instanceof Error ? error.message : 'The source action failed.'
}
function sourceProblem(category: string) {
  const wording: Record<string, string> = {
    network_error: 'Source could not be reached; refresh will retry',
    fetch_timeout: 'Source took too long to respond; refresh will retry',
    daily_budget_exhausted: 'Daily request limit reached; checks will resume tomorrow',
    invalid_config: 'Source setup needs repair',
    origin_invalid:
      'The source address is no longer approved for this venue; re-approve it in venue sources',
    redirect_forbidden:
      'The source redirected to an address that is not on the approved list; add that address or fix the source URL',
    internal_error: 'Checking the source failed on our side; it will be retried',
    cache_invalid: 'Saved comparison data was unusable; the next check will fetch the full page',
    review_required: 'Extracted changes need review',
    unsupported_content_type: 'The source format is unsupported',
  }
  return wording[category] ?? category.replaceAll('_', ' ')
}
function asIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value
}
function when(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'never'
}
function scheduleWhen(value: string, timezone: string | undefined) {
  return new Date(value).toLocaleString(undefined, { timeZone: timezone ?? 'UTC' })
}
function previewOf(value: unknown): Preview | null {
  if (!value || typeof value !== 'object') return null
  const preview = value as Partial<Preview>
  return typeof preview.previewId === 'string' &&
    typeof preview.previewHash === 'string' &&
    Array.isArray(preview.records) &&
    Array.isArray(preview.issues)
    ? (preview as Preview)
    : null
}

export function SourceConnectionsSettings({ venueId }: { venueId: string }) {
  const client = useTRPCClient()
  const [sources, setSources] = useState<SourceView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingPreview, setPendingPreview] = useState<{
    id: string
    previousAt: string | null
    startedAt: number
    mode: 'preview' | 'refresh'
  } | null>(null)
  const [editing, setEditing] = useState<{ id: string; expectedUpdatedAt: string } | null>(null)
  const [name, setName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [linkedUrls, setLinkedUrls] = useState('')
  const [timezone, setTimezone] = useState('America/Chicago')
  const [refreshMinutes, setRefreshMinutes] = useState(60)
  const [freshnessMinutes, setFreshnessMinutes] = useState(180)
  const [policy, setPolicy] = useState<'review_required' | 'auto_verified'>('review_required')
  const [adapter, setAdapter] = useState<'html' | 'json_feed'>('html')
  const [kind, setKind] = useState<'description' | 'showtime' | 'closure' | 'event'>('event')
  const [recordPath, setRecordPath] = useState('article')
  const [idPath, setIdPath] = useState('h3')
  const [titlePath, setTitlePath] = useState('h3')
  const [textPath, setTextPath] = useState('p')
  const [startPath, setStartPath] = useState('')
  const [endPath, setEndPath] = useState('')
  const [showtimePath, setShowtimePath] = useState('')
  const [showtimeEndPath, setShowtimeEndPath] = useState('')
  const [linkPath, setLinkPath] = useState('')
  const [dateAttribute, setDateAttribute] = useState<'text' | 'datetime'>('text')
  const [timeAttribute, setTimeAttribute] = useState<'text' | 'datetime'>('text')
  const [pageDatePath, setPageDatePath] = useState('')
  const [dateFormat, setDateFormat] = useState<
    'iso' | 'english_month_day_year' | 'english_month_day'
  >('iso')
  const [minRecords, setMinRecords] = useState(1)
  const [maxRecords, setMaxRecords] = useState(50)
  const [maxChangedFraction, setMaxChangedFraction] = useState(0.5)
  const [maxRequestsPerDay, setMaxRequestsPerDay] = useState(24)
  const [advanced, setAdvanced] = useState(false)
  const [advancedJson, setAdvancedJson] = useState('')

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const rows = await runBoundedClientRequest({
        parentSignal: signal ?? new AbortController().signal,
        timeoutMs: 15_000,
        request: (requestSignal) =>
          client.sourceConnections.list.query({ venueId }, { signal: requestSignal }),
      })
      if (!signal?.aborted) setSources(rows as SourceView[])
    },
    [client, venueId],
  )

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).catch((loadError) => {
      if (!controller.signal.aborted) setError(errorText(loadError))
    })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    if (!pendingPreview) return
    const controller = new AbortController()
    let loading = false
    const timer = setInterval(() => {
      if (Date.now() - pendingPreview.startedAt > 120_000) {
        setPendingPreview(null)
        setNotice('The check is still queued. Reload this page later to see the result.')
        return
      }
      if (loading) return
      loading = true
      void reload(controller.signal)
        .catch((loadError) => {
          if (!controller.signal.aborted) setError(errorText(loadError))
        })
        .finally(() => {
          loading = false
        })
    }, 3_000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [pendingPreview, reload])

  useEffect(() => {
    if (!pendingPreview || !sources) return
    const row = sources.find((source) => source.id === pendingPreview.id)
    const completedAt = pendingPreview.mode === 'preview' ? row?.previewAt : row?.lastAttemptAt
    if (completedAt && asIso(completedAt) !== pendingPreview.previousAt) setPendingPreview(null)
  }, [pendingPreview, sources])

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      await reload()
      setNotice(success)
    } catch (actionError) {
      setError(errorText(actionError))
      await reload().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  function makeConfig(): SourceConnectionConfig {
    if (advancedJson.trim()) return SourceConnectionConfigSchema.parse(JSON.parse(advancedJson))
    const mapping =
      adapter === 'html'
        ? {
            type: 'html' as const,
            kind,
            recordSelector: recordPath.trim(),
            id: { selector: idPath.trim(), attribute: 'text' as const },
            title: { selector: titlePath.trim(), attribute: 'text' as const },
            text: { selector: textPath.trim(), attribute: 'text' as const },
            ...(startPath.trim()
              ? { startDate: { selector: startPath.trim(), attribute: dateAttribute } }
              : {}),
            ...(endPath.trim()
              ? { endDate: { selector: endPath.trim(), attribute: dateAttribute } }
              : {}),
            ...(pageDatePath.trim()
              ? { pageDate: { selector: pageDatePath.trim(), attribute: 'text' as const } }
              : {}),
            ...(showtimePath.trim()
              ? { showtime: { selector: showtimePath.trim(), attribute: timeAttribute } }
              : {}),
            ...(showtimeEndPath.trim()
              ? { showtimeEnd: { selector: showtimeEndPath.trim(), attribute: timeAttribute } }
              : {}),
            ...(linkPath.trim()
              ? { link: { selector: linkPath.trim(), attribute: 'href' as const } }
              : {}),
            dateFormat,
          }
        : {
            type: 'json_feed' as const,
            kind,
            itemsPointer: recordPath.trim(),
            idPointer: idPath.trim(),
            titlePointer: titlePath.trim(),
            textPointer: textPath.trim(),
            ...(startPath.trim() ? { startDatePointer: startPath.trim() } : {}),
            ...(endPath.trim() ? { endDatePointer: endPath.trim() } : {}),
            ...(showtimePath.trim() ? { showtimesPointer: showtimePath.trim() } : {}),
            ...(showtimeEndPath.trim() ? { showtimeEndsPointer: showtimeEndPath.trim() } : {}),
            ...(linkPath.trim() ? { linksPointer: linkPath.trim() } : {}),
            dateFormat,
          }
    return SourceConnectionConfigSchema.parse({
      version: 1,
      sourceUrl: sourceUrl.trim(),
      allowedUrls: [
        sourceUrl.trim(),
        ...linkedUrls
          .split('\n')
          .map((url) => url.trim())
          .filter(Boolean),
      ],
      mappings: [mapping],
      timezone: timezone.trim(),
      refreshIntervalSeconds: refreshMinutes * 60,
      freshnessSeconds: freshnessMinutes * 60,
      validation: { minRecords, maxRecords, maxChangedFraction, maxRequestsPerDay },
      publicationPolicy: policy,
    })
  }

  function loadForEdit(source: SourceView) {
    if (!source.config) return
    const config = source.config
    const mapping = config.mappings[0]
    if (!mapping) return
    setEditing({ id: source.id, expectedUpdatedAt: asIso(source.updatedAt) })
    setName(source.name)
    setSourceUrl(config.sourceUrl)
    setLinkedUrls(config.allowedUrls.filter((url) => url !== config.sourceUrl).join('\n'))
    setTimezone(config.timezone)
    setRefreshMinutes(config.refreshIntervalSeconds / 60)
    setFreshnessMinutes(config.freshnessSeconds / 60)
    setPolicy(config.publicationPolicy)
    setMinRecords(config.validation.minRecords)
    setMaxRecords(config.validation.maxRecords)
    setMaxChangedFraction(config.validation.maxChangedFraction)
    setMaxRequestsPerDay(config.validation.maxRequestsPerDay)
    setAdapter(mapping.type)
    setKind(mapping.kind)
    setRecordPath(mapping.type === 'html' ? mapping.recordSelector : mapping.itemsPointer)
    setIdPath(mapping.type === 'html' ? mapping.id.selector : mapping.idPointer)
    setTitlePath(mapping.type === 'html' ? mapping.title.selector : mapping.titlePointer)
    setTextPath(mapping.type === 'html' ? mapping.text.selector : mapping.textPointer)
    setStartPath(
      mapping.type === 'html'
        ? (mapping.startDate?.selector ?? '')
        : (mapping.startDatePointer ?? ''),
    )
    setEndPath(
      mapping.type === 'html' ? (mapping.endDate?.selector ?? '') : (mapping.endDatePointer ?? ''),
    )
    setShowtimePath(
      mapping.type === 'html'
        ? (mapping.showtime?.selector ?? '')
        : (mapping.showtimesPointer ?? ''),
    )
    setShowtimeEndPath(
      mapping.type === 'html'
        ? (mapping.showtimeEnd?.selector ?? '')
        : (mapping.showtimeEndsPointer ?? ''),
    )
    setLinkPath(
      mapping.type === 'html' ? (mapping.link?.selector ?? '') : (mapping.linksPointer ?? ''),
    )
    setDateAttribute(
      mapping.type === 'html' && mapping.startDate?.attribute === 'datetime' ? 'datetime' : 'text',
    )
    setTimeAttribute(
      mapping.type === 'html' && mapping.showtime?.attribute === 'datetime' ? 'datetime' : 'text',
    )
    setPageDatePath(mapping.type === 'html' ? (mapping.pageDate?.selector ?? '') : '')
    setDateFormat(mapping.dateFormat)
    const richMapping =
      config.mappings.length > 1 ||
      Object.keys(mapping).some(
        (key) =>
          ![
            'type',
            'kind',
            'recordSelector',
            'id',
            'title',
            'text',
            'startDate',
            'endDate',
            'pageDate',
            'dateFormat',
            'allowCrossMidnight',
            'itemsPointer',
            'idPointer',
            'titlePointer',
            'textPointer',
            'startDatePointer',
            'endDatePointer',
          ].includes(key),
      ) ||
      (mapping.type === 'html' &&
        (mapping.allowCrossMidnight ||
          [
            mapping.id,
            mapping.title,
            mapping.text,
            mapping.startDate,
            mapping.endDate,
            mapping.pageDate,
          ].some((field) => field && field.attribute !== 'text')))
    setAdvanced(richMapping)
    setAdvancedJson(richMapping ? JSON.stringify({ ...config, approval: undefined }, null, 2) : '')
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(
      async () => {
        const config = makeConfig()
        if (editing) {
          await client.sourceConnections.updateDraft.mutate({
            venueId,
            connectorId: editing.id,
            expectedUpdatedAt: editing.expectedUpdatedAt,
            config,
          })
        } else {
          await client.sourceConnections.createDraft.mutate({ venueId, name: name.trim(), config })
        }
        setEditing(null)
      },
      editing
        ? 'Draft updated. Preview the new mapping before approval.'
        : 'Draft added. Preview it before approval.',
    )
  }

  return (
    <section
      aria-labelledby="source-connections-heading"
      className="space-y-6 border-t border-pf-light pt-7"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
          Approved web sources
        </p>
        <h3 id="source-connections-heading" className="mt-2 text-xl font-semibold text-pf-deep">
          Source connections
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Connect an exact public page or JSON feed. Torchiko checks it in the background and shows
          you the extracted facts before they can reach guests.
        </p>
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() => void run(async () => undefined, 'Sources reloaded.')}
      >
        Reload sources
      </button>
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
      {sources === null ? (
        <p className="text-sm text-pf-deep/70">
          {error
            ? 'Source connections could not be loaded. Use Reload sources to try again.'
            : 'Loading source connections.'}
        </p>
      ) : sources.length === 0 ? (
        <p className="text-sm text-pf-deep/70">
          No approved web sources are set up for this venue.
        </p>
      ) : (
        <ul className="divide-y divide-pf-light border-y border-pf-light">
          {sources.map((source) => {
            const preview = previewOf(source.preview)
            const version = asIso(source.updatedAt)
            return (
              <li key={source.id} className="py-5" data-testid={`source-connection-${source.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-pf-deep">{source.name}</p>
                    <p className="mt-1 break-all text-xs text-pf-deep/70">
                      {source.config?.sourceUrl ?? 'Invalid configuration'}
                    </p>
                  </div>
                  <p className="text-xs font-semibold text-pf-deep/70">
                    {source.state === 'ACTIVE'
                      ? 'Running'
                      : source.state === 'DISABLED'
                        ? 'Paused'
                        : 'Needs repair'}{' '}
                    · {source.approved ? 'approved' : 'not approved'}
                  </p>
                </div>
                {source.config ? (
                  <p className="mt-2 text-xs text-pf-deep/70">
                    {source.config.mappings
                      .map(
                        (mapping) => `${mapping.kind} ${mapping.type === 'html' ? 'HTML' : 'JSON'}`,
                      )
                      .join(', ')}{' '}
                    · refresh every {source.config.refreshIntervalSeconds / 60} min · fresh for{' '}
                    {source.config.freshnessSeconds / 60} min · {source.config.timezone} · up to{' '}
                    {source.config.validation.maxRequestsPerDay} requests/day
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-pf-deep/70">
                  Last success: {when(source.lastSuccessAt)}. Last attempt:{' '}
                  {when(source.lastAttemptAt)}.
                  {source.lastErrorCategory
                    ? ` Last problem: ${sourceProblem(source.lastErrorCategory)} (${source.consecutiveFailures} consecutive).`
                    : ''}
                </p>
                {preview ? (
                  <div
                    className="mt-4 border-l-2 border-pf-accent pl-4"
                    aria-label={`Preview for ${source.name}`}
                  >
                    <p className="text-sm font-semibold text-pf-deep">
                      Preview ·{' '}
                      {source.config?.approval?.approvedPreviewHash === preview.previewHash
                        ? 'approved'
                        : preview.status === 'VALID'
                          ? 'ready for review'
                          : 'needs changes'}
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/70">
                      Checked {when(preview.observedAt)} · {preview.records.length} extracted
                      records
                      {preview.cost
                        ? ` · ${preview.cost.fetches} fetch, ${preview.cost.bytes} bytes`
                        : ''}
                    </p>
                    <p className="mt-1 text-xs text-pf-deep/70">
                      Deterministic extraction · 0 LLM tokens · $0 LLM cost · network cost unpriced
                      {preview.usage
                        ? ` · ${preview.usage.requests}/${source.config?.validation.maxRequestsPerDay} requests used on ${preview.usage.day} · ${preview.usage.bytes} bytes`
                        : ''}
                    </p>
                    {preview.issues.length ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
                        {preview.issues.map((issue, index) => (
                          <li key={`${index}-${issue}`}>{sourceProblem(issue)}</li>
                        ))}
                      </ul>
                    ) : null}
                    <ul className="mt-3 max-h-72 space-y-3 overflow-y-auto text-sm text-pf-deep/80">
                      {preview.records.map((record) => (
                        <li key={record.id} className="border-b border-pf-light pb-2">
                          <strong className="text-pf-deep">{record.title}</strong>{' '}
                          <span className="text-xs">({record.kind})</span>
                          <p>{record.text}</p>
                          <p className="text-xs">
                            {record.startDate ?? 'No start date'}
                            {record.endDate && record.endDate !== record.startDate
                              ? ` to ${record.endDate}`
                              : ''}
                            {record.cancelled ? ' · Cancelled' : ''}
                          </p>
                          {record.showtimes.length ? (
                            <ul className="mt-1 text-xs">
                              {record.showtimes.map((showtime) => (
                                <li key={showtime.startAt}>
                                  {scheduleWhen(showtime.startAt, source.config?.timezone)} to{' '}
                                  {scheduleWhen(showtime.endAt, source.config?.timezone)} (
                                  {source.config?.timezone})
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {record.exceptions?.length ? (
                            <p className="text-xs">Exceptions: {record.exceptions.join(', ')}</p>
                          ) : null}
                          {record.links.map((link) => (
                            <p key={link}>
                              <a
                                className="break-all text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-pf-accent"
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {link}
                              </a>
                            </p>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {source.previewErrorCategory ? (
                  <p role="status" className="mt-3 text-sm text-amber-900">
                    Latest preview problem: {sourceProblem(source.previewErrorCategory)}. Review the
                    setup and preview it again.
                  </p>
                ) : null}
                {source.snapshot ? (
                  <p className="mt-3 text-xs text-pf-deep/70">
                    Published snapshot checked {when(source.snapshotFetchedAt)}.
                  </p>
                ) : null}
                <p className="mt-3 text-xs text-pf-deep/70">
                  {source.config?.publicationPolicy === 'auto_verified'
                    ? 'After approval, future changes publish automatically only when validation passes.'
                    : 'Each changed snapshot needs your review before publication.'}{' '}
                  Guests use only current, validated facts; expired facts are withheld.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || !source.config || source.state === 'ACTIVE'}
                    onClick={() => loadForEdit(source)}
                  >
                    Edit setup
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || !source.config || pendingPreview?.id === source.id}
                    onClick={() =>
                      void run(async () => {
                        await client.sourceConnections.requestPreview.mutate({
                          venueId,
                          connectorId: source.id,
                          expectedUpdatedAt: version,
                        })
                        setPendingPreview({
                          id: source.id,
                          previousAt: source.previewAt ? asIso(source.previewAt) : null,
                          startedAt: Date.now(),
                          mode: 'preview',
                        })
                      }, 'Preview queued. Results will appear here shortly.')
                    }
                  >
                    {pendingPreview?.id === source.id ? 'Preview queued…' : 'Preview source'}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={
                      busy ||
                      !preview ||
                      preview.status !== 'VALID' ||
                      source.config?.approval?.approvedPreviewHash === preview.previewHash
                    }
                    onClick={() =>
                      void run(
                        () =>
                          client.sourceConnections.approvePreview.mutate({
                            venueId,
                            connectorId: source.id,
                            expectedUpdatedAt: version,
                            previewId: preview!.previewId,
                            previewHash: preview!.previewHash,
                          }),
                        'Exact preview and mapping approved.',
                      )
                    }
                  >
                    Approve preview
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || (source.state !== 'ACTIVE' && !source.approved)}
                    onClick={() =>
                      void run(
                        () =>
                          source.state === 'ACTIVE'
                            ? client.sourceConnections.pause.mutate({
                                venueId,
                                connectorId: source.id,
                                expectedUpdatedAt: version,
                              })
                            : client.sourceConnections.resume.mutate({
                                venueId,
                                connectorId: source.id,
                                expectedUpdatedAt: version,
                              }),
                        source.state === 'ACTIVE' ? 'Source paused.' : 'Source resumed.',
                      )
                    }
                  >
                    {source.state === 'ACTIVE' ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={
                      busy ||
                      source.state !== 'ACTIVE' ||
                      !source.approved ||
                      pendingPreview?.id === source.id
                    }
                    onClick={() =>
                      void run(async () => {
                        await client.sourceConnections.requestRefresh.mutate({
                          venueId,
                          connectorId: source.id,
                          expectedUpdatedAt: version,
                        })
                        setPendingPreview({
                          id: source.id,
                          previousAt: source.lastAttemptAt ? asIso(source.lastAttemptAt) : null,
                          startedAt: Date.now(),
                          mode: 'refresh',
                        })
                      }, 'Refresh queued.')
                    }
                  >
                    Refresh now
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <form onSubmit={submit} aria-busy={busy} className="space-y-4 border-t border-pf-light pt-6">
        <h4 className="text-lg font-semibold text-pf-deep">
          {editing ? 'Edit source draft' : 'Add source draft'}
        </h4>
        {advancedJson.trim() ? (
          <p className="text-sm text-amber-900">
            This setup contains additional fields. The full configuration below is used when you
            save; clear it to use the simple fields.
          </p>
        ) : null}
        <p className="text-sm text-pf-deep/70">
          Exact HTTPS addresses only. Include any linked page the extractor may follow. Leave
          credentials and private links out.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold text-pf-deep">
            Source name
            <input
              className={inputClass}
              required
              maxLength={120}
              value={name}
              disabled={Boolean(editing)}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Time zone
            <input
              className={inputClass}
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep sm:col-span-2">
            Public source URL
            <input
              className={inputClass}
              type="url"
              required
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep sm:col-span-2">
            Other exact approved URLs, one per line
            <textarea
              className={`${inputClass} min-h-20 py-3 text-sm`}
              value={linkedUrls}
              onChange={(event) => setLinkedUrls(event.target.value)}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Refresh interval (minutes)
            <input
              className={inputClass}
              type="number"
              min={5}
              max={1440}
              required
              value={refreshMinutes}
              onChange={(event) => setRefreshMinutes(Number(event.target.value))}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Freshness limit (minutes)
            <input
              className={inputClass}
              type="number"
              min={1}
              max={43200}
              required
              value={freshnessMinutes}
              onChange={(event) => setFreshnessMinutes(Number(event.target.value))}
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Publication policy
            <select
              className={inputClass}
              value={policy}
              onChange={(event) => setPolicy(event.target.value as typeof policy)}
            >
              <option value="review_required">Review each change</option>
              <option value="auto_verified">Publish validated changes automatically</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Adapter
            <select
              className={inputClass}
              value={adapter}
              onChange={(event) => {
                const next = event.target.value as typeof adapter
                setAdapter(next)
                setRecordPath(next === 'html' ? 'article' : '/items')
                setIdPath(next === 'html' ? 'h3' : '/id')
                setTitlePath(next === 'html' ? 'h3' : '/title')
                setTextPath(next === 'html' ? 'p' : '/text')
                setStartPath('')
                setEndPath('')
                setPageDatePath('')
                setShowtimePath('')
                setShowtimeEndPath('')
                setLinkPath('')
              }}
            >
              <option value="html">HTML selectors</option>
              <option value="json_feed">JSON feed paths</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Information kind
            <select
              className={inputClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="event">Event</option>
              <option value="showtime">Showtime</option>
              <option value="closure">Closure</option>
              <option value="description">Description</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Date format
            <select
              className={inputClass}
              value={dateFormat}
              onChange={(event) => setDateFormat(event.target.value as typeof dateFormat)}
            >
              <option value="iso">ISO date</option>
              <option value="english_month_day_year">Month day, year</option>
              <option value="english_month_day">Month day (page date required)</option>
            </select>
          </label>
        </div>
        <p className="text-xs leading-5 text-pf-deep/70">
          HTML fields use simple selectors such as h3 or time.start. JSON fields use paths such as
          /title. Showtimes need both start and end values; links must match an approved URL.
        </p>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-semibold text-pf-deep">
            {adapter === 'html' ? 'Deterministic CSS selectors' : 'JSON pointers into each record'}
          </legend>
          {[
            ['Records', recordPath, setRecordPath],
            ['ID', idPath, setIdPath],
            ['Title', titlePath, setTitlePath],
            ['Description', textPath, setTextPath],
            ['Start date (optional)', startPath, setStartPath],
            ['End date (optional)', endPath, setEndPath],
            ['Showtime start (optional)', showtimePath, setShowtimePath],
            ['Showtime end (optional)', showtimeEndPath, setShowtimeEndPath],
            ['Link (optional)', linkPath, setLinkPath],
          ].map(([label, value, setter]) => (
            <label key={label as string} className="text-sm font-semibold text-pf-deep">
              {label as string}
              <input
                className={inputClass}
                required={!String(label).includes('optional')}
                value={value as string}
                onChange={(event) => (setter as (value: string) => void)(event.target.value)}
                placeholder={adapter === 'html' ? 'article .title' : '/items'}
              />
            </label>
          ))}
          {adapter === 'html' ? (
            <>
              <label className="text-sm font-semibold text-pf-deep">
                Date value source
                <select
                  className={inputClass}
                  value={dateAttribute}
                  onChange={(event) => setDateAttribute(event.target.value as typeof dateAttribute)}
                >
                  <option value="text">Visible text</option>
                  <option value="datetime">HTML datetime attribute</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-pf-deep">
                Showtime value source
                <select
                  className={inputClass}
                  value={timeAttribute}
                  onChange={(event) => setTimeAttribute(event.target.value as typeof timeAttribute)}
                >
                  <option value="text">Visible text</option>
                  <option value="datetime">HTML datetime attribute</option>
                </select>
              </label>
            </>
          ) : null}
          {adapter === 'html' && dateFormat === 'english_month_day' ? (
            <label className="text-sm font-semibold text-pf-deep">
              Page date selector
              <input
                className={inputClass}
                required
                value={pageDatePath}
                onChange={(event) => setPageDatePath(event.target.value)}
              />
            </label>
          ) : null}
        </fieldset>
        <details
          className="border-t border-pf-light pt-4"
          open={advanced}
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-semibold text-pf-deep">
            Advanced mapping and validation
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-pf-deep">
              Minimum records
              <input
                className={inputClass}
                type="number"
                min={1}
                max={100}
                value={minRecords}
                onChange={(event) => setMinRecords(Number(event.target.value))}
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Maximum records
              <input
                className={inputClass}
                type="number"
                min={1}
                max={100}
                value={maxRecords}
                onChange={(event) => setMaxRecords(Number(event.target.value))}
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Maximum changed fraction
              <input
                className={inputClass}
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={maxChangedFraction}
                onChange={(event) => setMaxChangedFraction(Number(event.target.value))}
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Maximum requests per day
              <input
                className={inputClass}
                type="number"
                min={1}
                max={48}
                value={maxRequestsPerDay}
                onChange={(event) => setMaxRequestsPerDay(Number(event.target.value))}
              />
            </label>
          </div>
          <label className="mt-4 block text-sm font-semibold text-pf-deep">
            Full versioned configuration JSON (optional for multiple mappings)
            <textarea
              className={`${inputClass} min-h-40 py-3 font-mono text-xs`}
              value={advancedJson}
              onChange={(event) => setAdvancedJson(event.target.value)}
            />
          </label>
        </details>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} disabled={busy}>
            {editing ? 'Save draft changes' : 'Add draft'}
          </button>
          {editing ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel edit
            </button>
          ) : null}
        </div>
      </form>
    </section>
  )
}
