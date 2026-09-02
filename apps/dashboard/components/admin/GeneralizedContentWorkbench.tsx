'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'

const CONTENT_PREVIEW_TIMEOUT_MS = 15_000

const kinds = ['ITEM', 'SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'] as const
type Kind = (typeof kinds)[number]

type EditableModule = {
  id: string
  revisionId: string
  kind: Kind
  version: number
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  effectiveFrom: string | null
  effectiveUntil: string | null
  payload: Record<string, unknown>
  publishedRevisionId: string | null
}

type WorkbenchProps = {
  tenantId: string
  venueId: string
  authoringEnabled: boolean
  initialCreationKey: string
  modules: EditableModule[]
}

const templates: Record<Kind, Record<string, unknown>> = {
  ITEM: { kind: 'ITEM', name: '', description: null, placeId: null, itemType: '' },
  SERVICE: { kind: 'SERVICE', name: '', description: null, availability: null, placeId: null },
  POLICY: { kind: 'POLICY', title: '', rule: '', appliesTo: [] },
  EVENT: {
    kind: 'EVENT',
    name: '',
    description: null,
    startsAt: new Date().toISOString(),
    endsAt: null,
    placeId: null,
  },
  OPERATIONAL_FACT: { kind: 'OPERATIONAL_FACT', label: '', value: '', expiresAt: null },
  RELATIONSHIP: {
    kind: 'RELATIONSHIP',
    fromModuleId: '',
    toModuleId: '',
    relationshipType: '',
    description: null,
  },
}

function dateInput(value: string | null): string {
  return value ? new Date(value).toISOString().slice(0, 16) : ''
}

function toIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function safeError(action: 'preview' | 'save' | 'retire' | 'publication'): string {
  if (action === 'preview') return 'The draft could not be validated. Review the entered JSON.'
  if (action === 'retire') return 'The retirement revision could not be confirmed.'
  if (action === 'publication')
    return 'The publication outcome is unknown. Retry only if this exact revision is unchanged.'
  return 'The revision outcome is unknown. Refresh this exact module before retrying.'
}

export function GeneralizedContentWorkbench({
  tenantId,
  venueId,
  authoringEnabled,
  initialCreationKey,
  modules,
}: WorkbenchProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string>('new')
  const [creationKey, setCreationKey] = useState(initialCreationKey)
  const selected = useMemo(
    () => modules.find((item) => item.id === selectedId) ?? null,
    [modules, selectedId],
  )
  const [kind, setKind] = useState<Kind>('SERVICE')
  const [audience, setAudience] = useState<'PUBLIC' | 'CLIENT' | 'OPERATOR'>('OPERATOR')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [effectiveUntil, setEffectiveUntil] = useState('')
  const [payloadJson, setPayloadJson] = useState(JSON.stringify(templates.SERVICE, null, 2))
  const [evidenceJson, setEvidenceJson] = useState('[]')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [readyScope, setReadyScope] = useState('')
  const [requiresReview, setRequiresReview] = useState(false)
  const [retirementTargetId, setRetirementTargetId] = useState<string | null>(null)
  const [retirementBoundary, setRetirementBoundary] = useState('')
  const panelInFlight = useRef(false)
  const publicationRequestKeys = useRef(new Map<string, string>())
  const previewAbort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const feedbackHeading = useRef<HTMLHeadingElement>(null)
  const propScope = `${tenantId}:${venueId}:${initialCreationKey}:${modules
    .map(
      (module) =>
        `${module.id}:${module.revisionId}:${module.version}:${module.audience}:${module.publishedRevisionId ?? ''}`,
    )
    .join('|')}`
  const renderedScope = useRef(propScope)
  if (renderedScope.current !== propScope) {
    renderedScope.current = propScope
    generation.current += 1
    previewAbort.current?.abort()
    previewAbort.current = null
    panelInFlight.current = false
    publicationRequestKeys.current.clear()
  }
  const scopeReady = readyScope === propScope

  useEffect(() => {
    setReadyScope(propScope)
    setSelectedId('new')
    setCreationKey(initialCreationKey)
    setKind('SERVICE')
    setAudience('OPERATOR')
    setEffectiveFrom('')
    setEffectiveUntil('')
    setPayloadJson(JSON.stringify(templates.SERVICE, null, 2))
    setEvidenceJson('[]')
    setNotice(null)
    setError(null)
    setBusy(false)
    setRequiresReview(false)
    setRetirementTargetId(null)
    setRetirementBoundary('')
    panelInFlight.current = false
    publicationRequestKeys.current.clear()
  }, [initialCreationKey, propScope])

  useEffect(
    () => () => {
      generation.current += 1
      previewAbort.current?.abort()
      previewAbort.current = null
      panelInFlight.current = false
    },
    [],
  )

  useEffect(() => {
    if (error || notice) feedbackHeading.current?.focus()
  }, [error, notice])

  function isCurrent(startedGeneration: number, startedScope: string) {
    return generation.current === startedGeneration && renderedScope.current === startedScope
  }

  function begin() {
    if (!scopeReady || requiresReview || panelInFlight.current) return null
    panelInFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    return { generation: generation.current, scope: propScope }
  }

  function finish(started: { generation: number; scope: string }) {
    if (!isCurrent(started.generation, started.scope)) return
    panelInFlight.current = false
    setBusy(false)
  }

  function conflict(actionIdentity?: string) {
    if (actionIdentity) publicationRequestKeys.current.delete(actionIdentity)
    setRequiresReview(true)
    setError('This module changed. Reload and review the authoritative revision before continuing.')
    router.refresh()
  }

  function loadModule(module: EditableModule | null) {
    if (!scopeReady || panelInFlight.current) return
    setSelectedId(module?.id ?? 'new')
    const nextKind = module?.kind ?? kind
    setKind(nextKind)
    setAudience(module?.audience ?? 'OPERATOR')
    setEffectiveFrom(dateInput(module?.effectiveFrom ?? null))
    setEffectiveUntil(dateInput(module?.effectiveUntil ?? null))
    setPayloadJson(JSON.stringify(module?.payload ?? templates[nextKind], null, 2))
    setEvidenceJson('[]')
    setNotice(null)
    setError(null)
    setRequiresReview(false)
    setRetirementTargetId(null)
    setRetirementBoundary('')
    publicationRequestKeys.current.clear()
    if (!module) setCreationKey(crypto.randomUUID())
  }

  function parsedDraft() {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    const evidence = JSON.parse(evidenceJson) as unknown[]
    return {
      audience,
      effectiveFrom: toIso(effectiveFrom),
      effectiveUntil: toIso(effectiveUntil),
      evidence,
      payload,
    }
  }

  async function preview() {
    const started = begin()
    if (!started) return
    const controller = new AbortController()
    previewAbort.current = controller
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: CONTENT_PREVIEW_TIMEOUT_MS,
        request: (signal) =>
          client.admin.previewUniversalContent.query(
            {
              tenantId,
              venueId,
              // The server contract is the authoritative JSON validator.
              draft: parsedDraft() as never,
            },
            { signal },
          ),
      })
      if (!isCurrent(started.generation, started.scope)) return
      setNotice(
        `${result.preview.lifecycle}. Stored for ${result.preview.audience}; guest and client publication remain off.`,
      )
    } catch {
      if (isCurrent(started.generation, started.scope)) setError(safeError('preview'))
    } finally {
      if (previewAbort.current === controller) previewAbort.current = null
      finish(started)
    }
  }

  async function save() {
    if (!authoringEnabled) return
    const started = begin()
    if (!started) return
    const target = selected
    if (
      target &&
      !modules.some(
        (module) =>
          module.id === target.id &&
          module.revisionId === target.revisionId &&
          module.version === target.version,
      )
    ) {
      finish(started)
      return
    }
    try {
      const draft = parsedDraft() as never
      const result = target
        ? await client.admin.addUniversalContentRevision.mutate({
            tenantId,
            venueId,
            moduleId: target.id,
            expectedLatestVersion: target.version,
            draft,
          })
        : await client.admin.createUniversalContent.mutate({
            tenantId,
            venueId,
            moduleId: creationKey,
            draft,
          })
      if (!isCurrent(started.generation, started.scope)) return
      setNotice(`Version ${result.version} recorded. Nothing was published.`)
      setRequiresReview(true)
      router.refresh()
    } catch (cause) {
      if (!isCurrent(started.generation, started.scope)) return
      const code = errorCode(cause)
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'NOT_FOUND') conflict()
      else setError(safeError('save'))
    } finally {
      finish(started)
    }
  }

  async function retire(module: EditableModule) {
    if (
      !authoringEnabled ||
      module.id !== selected?.id ||
      module.revisionId !== selected.revisionId ||
      module.version !== selected.version ||
      retirementTargetId !== module.id ||
      !retirementBoundary
    )
      return
    const started = begin()
    if (!started) return
    try {
      const result = await client.admin.retireUniversalContent.mutate({
        tenantId,
        venueId,
        moduleId: module.id,
        expectedLatestVersion: module.version,
        effectiveUntil: new Date(retirementBoundary).toISOString(),
        evidence: [],
      })
      if (!isCurrent(started.generation, started.scope)) return
      setNotice(`Retirement boundary recorded as version ${result.version}.`)
      setRequiresReview(true)
      router.refresh()
    } catch (cause) {
      if (!isCurrent(started.generation, started.scope)) return
      const code = errorCode(cause)
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'NOT_FOUND') conflict()
      else setError(safeError('retire'))
    } finally {
      finish(started)
    }
  }

  async function changePublication(module: EditableModule) {
    if (
      !authoringEnabled ||
      module.audience !== 'PUBLIC' ||
      module.id !== selected?.id ||
      module.revisionId !== selected.revisionId ||
      module.version !== selected.version ||
      !scopeReady ||
      requiresReview ||
      panelInFlight.current
    )
      return
    const publishing = module.publishedRevisionId !== module.revisionId
    const confirmed = window.confirm(
      publishing
        ? `Publish ${module.kind} version ${module.version} to the guest guide? This changes live guest context when the server capability flag is enabled.`
        : `Withdraw ${module.kind} version ${module.version} from the guest guide?`,
    )
    if (!confirmed) return
    const started = begin()
    if (!started) return
    const actionIdentity = `${publishing ? 'PUBLISH' : 'WITHDRAW'}:${module.id}:${module.revisionId}:${module.version}`
    try {
      const requestId = publicationRequestKeys.current.get(actionIdentity) ?? crypto.randomUUID()
      publicationRequestKeys.current.set(actionIdentity, requestId)
      const result = publishing
        ? await client.admin.publishUniversalContent.mutate({
            tenantId,
            venueId,
            moduleId: module.id,
            revisionId: module.revisionId,
            expectedLatestVersion: module.version,
            requestId,
          })
        : await client.admin.withdrawUniversalContent.mutate({
            tenantId,
            venueId,
            moduleId: module.id,
            expectedPublishedRevisionId: module.revisionId,
            requestId,
          })
      if (!isCurrent(started.generation, started.scope)) return
      setNotice(
        result.action === 'PUBLISH'
          ? `Version ${module.version} is explicitly published for effective guest resolution.`
          : `Version ${module.version} is withdrawn from guest resolution.`,
      )
      publicationRequestKeys.current.delete(actionIdentity)
      setRequiresReview(true)
      router.refresh()
    } catch (cause) {
      if (!isCurrent(started.generation, started.scope)) return
      const code = errorCode(cause)
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED' || code === 'NOT_FOUND')
        conflict(actionIdentity)
      else setError(safeError('publication'))
    } finally {
      finish(started)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
      aria-labelledby="content-editor-title"
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
            Human operator action
          </p>
          <h3 id="content-editor-title" className="mt-1 text-lg font-semibold text-pf-deep">
            Immutable revision editor
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-pf-deep/75">
            Validate a typed draft, then create a stable module or append its next revision. PUBLIC
            revisions remain private drafts until a human explicitly publishes one exact version;
            CLIENT and OPERATOR revisions are never guest-visible.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${authoringEnabled ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}
        >
          {authoringEnabled ? 'Authoring enabled' : 'Default-off flag disabled'}
        </span>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)]">
        <div>
          <label htmlFor="content-module" className="text-sm font-semibold text-pf-deep">
            Action target
          </label>
          <select
            id="content-module"
            value={scopeReady ? selectedId : 'new'}
            disabled={!scopeReady || busy || requiresReview}
            onChange={(event) =>
              loadModule(modules.find((item) => item.id === event.target.value) ?? null)
            }
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
          >
            <option value="new">Create a new module</option>
            {modules.map((module) => (
              <option key={module.id} value={module.id}>
                {module.kind} · v{module.version} · {module.id}
              </option>
            ))}
          </select>
          {selected ? (
            <div className="mt-3 space-y-2">
              <button
                type="button"
                onClick={() => changePublication(selected)}
                disabled={
                  !scopeReady ||
                  !authoringEnabled ||
                  busy ||
                  requiresReview ||
                  selected.audience !== 'PUBLIC'
                }
                className="min-h-10 w-full rounded-xl border border-pf-primary px-3 text-sm font-semibold text-pf-primary disabled:opacity-50"
              >
                {selected.publishedRevisionId === selected.revisionId
                  ? 'Withdraw from guest guide'
                  : 'Publish this version to guests'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRetirementTargetId(selected.id)
                  setRetirementBoundary(new Date().toISOString().slice(0, 16))
                  setError(null)
                  setNotice(null)
                }}
                disabled={!scopeReady || !authoringEnabled || busy || requiresReview}
                className="min-h-10 w-full rounded-xl border border-rose-200 px-3 text-sm font-semibold text-rose-800 disabled:opacity-50"
              >
                Append retirement revision
              </button>
              {retirementTargetId === selected.id ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                  <label className="text-sm font-semibold text-rose-950">
                    Retirement effective at
                    <input
                      type="datetime-local"
                      value={retirementBoundary}
                      disabled={busy || requiresReview}
                      onChange={(event) => setRetirementBoundary(event.target.value)}
                      className="mt-1 min-h-11 w-full rounded-lg border border-rose-200 bg-white px-2"
                    />
                  </label>
                  <p className="mt-2 text-xs text-rose-900">
                    This appends a revision. It does not delete history.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || requiresReview || !retirementBoundary}
                      onClick={() => void retire(selected)}
                      className="min-h-10 rounded-lg bg-rose-800 px-3 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Confirm retirement revision
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setRetirementTargetId(null)
                        setRetirementBoundary('')
                      }}
                      className="min-h-10 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-900"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm font-semibold text-pf-deep">
            Type
            <select
              value={kind}
              disabled={!scopeReady || busy || requiresReview || Boolean(selected)}
              onChange={(event) => {
                const next = event.target.value as Kind
                setKind(next)
                setPayloadJson(JSON.stringify(templates[next], null, 2))
              }}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
            >
              {kinds.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Audience
            <select
              value={audience}
              disabled={!scopeReady || busy || requiresReview}
              onChange={(event) => setAudience(event.target.value as typeof audience)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
            >
              <option>OPERATOR</option>
              <option>CLIENT</option>
              <option>PUBLIC</option>
            </select>
          </label>
          <div className="rounded-xl bg-pf-surface p-3 text-xs leading-5 text-pf-deep/75">
            Audience is metadata only here. PUBLIC guest publication requires the separate, explicit
            action for the selected stored revision.
          </div>
          <label className="text-sm font-semibold text-pf-deep">
            Effective from
            <input
              type="datetime-local"
              value={effectiveFrom}
              disabled={!scopeReady || busy || requiresReview}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Effective until
            <input
              type="datetime-local"
              value={effectiveUntil}
              disabled={!scopeReady || busy || requiresReview}
              onChange={(event) => setEffectiveUntil(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
            />
          </label>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <label className="text-sm font-semibold text-pf-deep">
          Typed payload JSON
          <textarea
            value={payloadJson}
            disabled={!scopeReady || busy || requiresReview}
            onChange={(event) => setPayloadJson(event.target.value)}
            spellCheck={false}
            rows={12}
            className="mt-1 w-full rounded-xl border border-pf-light p-3 font-mono text-xs leading-5"
          />
        </label>
        <label className="text-sm font-semibold text-pf-deep">
          Evidence references JSON
          <textarea
            value={evidenceJson}
            disabled={!scopeReady || busy || requiresReview}
            onChange={(event) => setEvidenceJson(event.target.value)}
            spellCheck={false}
            rows={12}
            className="mt-1 w-full rounded-xl border border-pf-light p-3 font-mono text-xs leading-5"
          />
          <span className="mt-1 block text-xs font-normal text-pf-deep/70">
            Each source accepts sourceId, capturedAt, optional locator, and optional SHA-256
            excerptHash.
          </span>
        </label>
      </div>

      {error || notice ? (
        <div
          className={`mt-4 rounded-xl p-3 ${error ? 'bg-rose-50 text-rose-900' : 'bg-emerald-50 text-emerald-900'}`}
          role={error ? 'alert' : 'status'}
        >
          <h4 ref={feedbackHeading} tabIndex={-1} className="text-sm font-semibold">
            {error ? 'Content action needs attention' : 'Content action recorded'}
          </h4>
          <p className="mt-1 text-sm">{error ?? notice}</p>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={preview}
          disabled={!scopeReady || busy || requiresReview}
          className="min-h-11 rounded-xl border border-pf-light px-5 text-sm font-semibold text-pf-deep disabled:opacity-50"
        >
          Validate and preview
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!scopeReady || !authoringEnabled || busy || requiresReview}
          className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {selected ? 'Append revision' : 'Create module'}
        </button>
      </div>
      {!selected ? (
        <p className="mt-2 break-all text-xs text-pf-deep/70">
          Creation request key: {creationKey}. Retrying this exact draft cannot create a second
          module; after a connection error, refresh and check this key first.
        </p>
      ) : null}
    </section>
  )
}
