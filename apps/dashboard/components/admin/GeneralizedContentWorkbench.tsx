'use client'

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

const kinds = ['SERVICE', 'POLICY', 'EVENT', 'OPERATIONAL_FACT', 'RELATIONSHIP'] as const
type Kind = (typeof kinds)[number]

type EditableModule = {
  id: string
  kind: Kind
  version: number
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  effectiveFrom: string | null
  effectiveUntil: string | null
  payload: Record<string, unknown>
}

type WorkbenchProps = {
  tenantId: string
  venueId: string
  authoringEnabled: boolean
  initialCreationKey: string
  modules: EditableModule[]
}

const templates: Record<Kind, Record<string, unknown>> = {
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

  function loadModule(module: EditableModule | null) {
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
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await client.admin.previewUniversalContent.query({
        tenantId,
        venueId,
        // The server contract is the authoritative JSON validator.
        draft: parsedDraft() as never,
      })
      setNotice(
        `${result.preview.lifecycle}. Stored for ${result.preview.audience}; guest and client publication remain off.`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The draft could not be validated.')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const draft = parsedDraft() as never
      const result = selected
        ? await client.admin.addUniversalContentRevision.mutate({
            tenantId,
            venueId,
            moduleId: selected.id,
            expectedLatestVersion: selected.version,
            draft,
          })
        : await client.admin.createUniversalContent.mutate({
            tenantId,
            venueId,
            moduleId: creationKey,
            draft,
          })
      setNotice(`Version ${result.version} recorded. Nothing was published.`)
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `The result is unknown. Refresh and look for request ${creationKey} before retrying.`,
      )
    } finally {
      setBusy(false)
    }
  }

  async function retire(module: EditableModule) {
    const boundary = window.prompt(
      'Retire at an ISO date/time. This appends a revision; it does not delete history.',
      new Date().toISOString(),
    )
    if (!boundary) return
    setBusy(true)
    setError(null)
    try {
      const result = await client.admin.retireUniversalContent.mutate({
        tenantId,
        venueId,
        moduleId: module.id,
        expectedLatestVersion: module.version,
        effectiveUntil: new Date(boundary).toISOString(),
        evidence: [],
      })
      setNotice(`Retirement boundary recorded as version ${result.version}.`)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Retirement was not recorded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
      aria-labelledby="content-editor-title"
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
            Validate a typed draft, then create a stable module or append its next revision. This
            workspace never publishes to guest or client surfaces.
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
            value={selectedId}
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
            <button
              type="button"
              onClick={() => retire(selected)}
              disabled={!authoringEnabled || busy}
              className="mt-3 min-h-10 w-full rounded-xl border border-rose-200 px-3 text-sm font-semibold text-rose-800 disabled:opacity-50"
            >
              Append retirement revision
            </button>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm font-semibold text-pf-deep">
            Type
            <select
              value={kind}
              disabled={Boolean(selected)}
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
              onChange={(event) => setAudience(event.target.value as typeof audience)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 text-sm"
            >
              <option>OPERATOR</option>
              <option>CLIENT</option>
              <option>PUBLIC</option>
            </select>
          </label>
          <div className="rounded-xl bg-pf-surface p-3 text-xs leading-5 text-pf-deep/75">
            Audience is metadata only here. Publication requires a separate, explicit future
            workflow.
          </div>
          <label className="text-sm font-semibold text-pf-deep">
            Effective from
            <input
              type="datetime-local"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Effective until
            <input
              type="datetime-local"
              value={effectiveUntil}
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

      {error ? (
        <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-900" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
          {notice}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={preview}
          disabled={busy}
          className="min-h-11 rounded-xl border border-pf-light px-5 text-sm font-semibold text-pf-deep disabled:opacity-50"
        >
          Validate and preview
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!authoringEnabled || busy}
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
