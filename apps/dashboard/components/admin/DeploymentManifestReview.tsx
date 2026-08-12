'use client'

import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type ReviewResult = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['reviewDeploymentManifest']['query']>
>
type FullPreviewResult = Awaited<
  ReturnType<
    ReturnType<typeof useTRPCClient>['admin']['previewFullVenueDeploymentManifest']['query']
  >
>

const COVERAGE_SECTIONS = [
  'IDENTITY',
  'BRANDING',
  'AI_CONFIGURATION',
  'CAPABILITIES',
  'CONTENT',
  'ASSETS',
  'EVALUATION',
] as const
const INITIAL_VISIBLE_ISSUES = 20

export function DeploymentManifestReview({
  tenantId,
  venueId,
}: {
  tenantId: string
  venueId: string
}) {
  const client = useTRPCClient()
  const scopeKey = `${tenantId}:${venueId}`
  const [manifestJson, setManifestJson] = useState('')
  const [inputScope, setInputScope] = useState(scopeKey)
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [resultScope, setResultScope] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manifestId, setManifestId] = useState(() => crypto.randomUUID())
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [fullPreview, setFullPreview] = useState<FullPreviewResult | null>(null)
  const [fullPreviewScope, setFullPreviewScope] = useState<string | null>(null)
  const [fullPreviewError, setFullPreviewError] = useState<string | null>(null)
  const [fullPreviewBusy, setFullPreviewBusy] = useState(false)
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null)
  const [artifactBusy, setArtifactBusy] = useState(false)
  const [visibleIssueCount, setVisibleIssueCount] = useState(INITIAL_VISIBLE_ISSUES)
  const running = useRef(false)
  const fullPreviewRunning = useRef(false)
  const artifactRunning = useRef(false)
  const renderedScope = useRef(scopeKey)
  const scopeGeneration = useRef(0)
  const resetScope = useRef(scopeKey)
  if (renderedScope.current !== scopeKey) {
    renderedScope.current = scopeKey
    scopeGeneration.current += 1
    running.current = false
    fullPreviewRunning.current = false
    artifactRunning.current = false
  }

  useEffect(() => {
    if (resetScope.current === scopeKey) return
    resetScope.current = scopeKey
    setManifestJson('')
    setManifestId(crypto.randomUUID())
    setIdempotencyKey(crypto.randomUUID())
    setInputScope(scopeKey)
    setResult(null)
    setResultScope(null)
    setError(null)
    setFullPreview(null)
    setFullPreviewScope(null)
    setFullPreviewError(null)
    setArtifactNotice(null)
    setVisibleIssueCount(INITIAL_VISIBLE_ISSUES)
    setBusy(false)
    setFullPreviewBusy(false)
    setArtifactBusy(false)
  }, [scopeKey])

  function scopeIsCurrent(generation: number, key: string) {
    return scopeGeneration.current === generation && renderedScope.current === key
  }
  const scopedResult = resultScope === scopeKey ? result : null
  const scopedFullPreview = fullPreviewScope === scopeKey ? fullPreview : null
  const scopeReady = inputScope === scopeKey
  const scopedManifestJson = scopeReady ? manifestJson : ''

  async function previewFullManifest() {
    if (!scopeReady || fullPreviewRunning.current) return
    fullPreviewRunning.current = true
    const generation = scopeGeneration.current
    const key = renderedScope.current
    setFullPreviewBusy(true)
    setFullPreviewError(null)
    setFullPreview(null)
    try {
      const next = await client.admin.previewFullVenueDeploymentManifest.query({
        tenantId,
        venueId,
        manifestId,
        idempotencyKey,
      })
      if (!scopeIsCurrent(generation, key)) return
      setFullPreview(next)
      setFullPreviewScope(key)
    } catch {
      if (!scopeIsCurrent(generation, key)) return
      setFullPreview(null)
      setFullPreviewError(
        'The FULL preview could not be generated. No manifest, package, or venue data was changed.',
      )
    } finally {
      if (scopeIsCurrent(generation, key)) {
        fullPreviewRunning.current = false
        setFullPreviewBusy(false)
      }
    }
  }

  function downloadFullManifest() {
    if (!scopedFullPreview) return
    const href = URL.createObjectURL(
      new Blob([scopedFullPreview.canonicalJson], { type: scopedFullPreview.download.mediaType }),
    )
    const link = document.createElement('a')
    link.href = href
    link.download = scopedFullPreview.download.filename
    link.click()
    URL.revokeObjectURL(href)
  }

  async function review() {
    if (!scopeReady || running.current || !scopedManifestJson.trim()) return
    running.current = true
    const generation = scopeGeneration.current
    const key = renderedScope.current
    setBusy(true)
    setError(null)
    try {
      const next = await client.admin.reviewDeploymentManifest.query({
        tenantId,
        venueId,
        manifestJson: scopedManifestJson,
      })
      if (!scopeIsCurrent(generation, key)) return
      setResult(next)
      setResultScope(key)
      setVisibleIssueCount(INITIAL_VISIBLE_ISSUES)
    } catch {
      if (!scopeIsCurrent(generation, key)) return
      setError(
        'The review could not be completed. The manifest text is preserved; no package or venue data was changed.',
      )
    } finally {
      if (scopeIsCurrent(generation, key)) {
        running.current = false
        setBusy(false)
      }
    }
  }

  async function recordArtifact() {
    if (
      !scopeReady ||
      artifactRunning.current ||
      !scopedResult?.materialization ||
      !scopedManifestJson.trim()
    )
      return
    artifactRunning.current = true
    const generation = scopeGeneration.current
    const key = renderedScope.current
    setArtifactBusy(true)
    setArtifactNotice(null)
    try {
      const recorded = await client.admin.createVenuePackageManifestArtifact.mutate({
        tenantId,
        venueId,
        manifestJson: scopedManifestJson,
      })
      if (!scopeIsCurrent(generation, key)) return
      setArtifactNotice(
        recorded.draft
          ? recorded.replayed
            ? 'This exact immutable review artifact and its linked compatibility DRAFT were already recorded.'
            : 'Immutable review artifact and linked compatibility DRAFT created atomically. Nothing was approved or applied.'
          : recorded.replayed
            ? 'This exact immutable review artifact was already recorded. No venue package was created or applied.'
            : 'Immutable review artifact recorded. No venue package was created or applied.',
      )
    } catch {
      if (!scopeIsCurrent(generation, key)) return
      setArtifactNotice(
        'The artifact outcome could not be confirmed. Retry unchanged to reconcile the same manifest identity.',
      )
    } finally {
      if (scopeIsCurrent(generation, key)) {
        artifactRunning.current = false
        setArtifactBusy(false)
      }
    }
  }

  const issues = scopedResult?.materialization?.issues ?? scopedResult?.issues ?? []
  const visibleIssues = issues.slice(0, visibleIssueCount)
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
          Read-only FULL projection
        </p>
        <h2 className="mt-1 text-2xl font-semibold text-pf-deep">Export current venue state</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Generate a validated Venue Deployment Manifest v2 preview from safe current venue
          configuration fields. This is not a publication snapshot. Generalized content, immutable
          assets, capability truth, model references, and deployment readiness remain explicitly
          omitted. This does not create or apply a package.
        </p>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className="text-sm font-semibold text-pf-deep">
            Manifest ID
            <input
              aria-label="FULL manifest ID"
              value={scopeReady ? manifestId : ''}
              disabled={!scopeReady || fullPreviewBusy}
              onChange={(event) => {
                setManifestId(event.target.value)
                setFullPreview(null)
                setFullPreviewError(null)
              }}
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light px-3 font-mono text-xs"
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Idempotency key
            <input
              aria-label="FULL idempotency key"
              value={scopeReady ? idempotencyKey : ''}
              disabled={!scopeReady || fullPreviewBusy}
              onChange={(event) => {
                setIdempotencyKey(event.target.value)
                setFullPreview(null)
                setFullPreviewError(null)
              }}
              className="mt-2 min-h-11 w-full rounded-xl border border-pf-light px-3 font-mono text-xs"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!scopeReady || fullPreviewBusy}
            onClick={() => void previewFullManifest()}
            className="min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {fullPreviewBusy ? 'Generating…' : 'Generate FULL preview'}
          </button>
          {scopedFullPreview ? (
            <button
              type="button"
              onClick={downloadFullManifest}
              className="min-h-11 rounded-2xl border border-pf-primary px-5 text-sm font-semibold text-pf-primary"
            >
              Download reviewed JSON
            </button>
          ) : null}
        </div>
        {fullPreviewError ? (
          <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="alert">
            {fullPreviewError}
          </p>
        ) : null}
      </section>
      {scopedFullPreview ? (
        <section className="space-y-4" aria-label="FULL manifest preview">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="font-semibold text-amber-950">Not ready to apply</p>
            <p className="mt-1 break-all font-mono text-xs text-amber-950">
              Canonical hash: {scopedFullPreview.manifestHash}
            </p>
          </div>
          <IssueList
            title="Truthful omissions"
            items={scopedFullPreview.readiness.omissions.map((item) => ({
              code: item.code,
              path: item.section,
              message: item.message,
            }))}
            empty="No omissions."
            tone="warning"
          />
          <JsonShape title="Canonical FULL manifest" value={scopedFullPreview.manifest} />
        </section>
      ) : null}
      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
          Internal review only
        </p>
        <h2 className="mt-1 text-2xl font-semibold text-pf-deep">Venue Deployment Manifest v2</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Validate a PATCH manifest and inspect its exact handoff into the existing VenuePackage
          lifecycle. Review does not persist anything. Recording is a separate explicit action: it
          always persists immutable artifact evidence, and a supported PATCH also atomically creates
          or replays its linked compatibility DRAFT. Recording never approves or applies a package.
        </p>
        <label className="mt-5 block text-sm font-semibold text-pf-deep">
          Manifest JSON
          <textarea
            aria-label="Manifest JSON"
            value={scopedManifestJson}
            onChange={(event) => {
              setManifestJson(event.target.value)
              setResult(null)
              setResultScope(null)
              setArtifactNotice(null)
              setVisibleIssueCount(INITIAL_VISIBLE_ISSUES)
            }}
            maxLength={250000}
            spellCheck={false}
            className="mt-2 min-h-72 w-full rounded-2xl border border-pf-light bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            placeholder="Paste one Venue Deployment Manifest v2 JSON object."
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!scopeReady || busy || !scopedManifestJson.trim()}
            onClick={() => void review()}
            className="min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {busy ? 'Reviewing…' : 'Review manifest'}
          </button>
          <span className="text-xs text-pf-deep/75">
            Maximum 250,000 characters. Review alone does not persist submitted text.
          </span>
        </div>
        {error ? (
          <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {scopedResult ? (
        <section className="space-y-5" aria-label="Manifest conversion review">
          <div
            className={`rounded-2xl border p-4 ${scopedResult.compatible ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}
            role="status"
          >
            <p className="font-semibold">
              {scopedResult.materialization?.status === 'MATERIALIZABLE'
                ? 'PATCH artifact is materializable through the proven legacy bridge'
                : scopedResult.materialization
                  ? 'Artifact is not materializable'
                  : 'Manifest could not be validated'}
            </p>
            <p className="mt-1 text-xs">
              Scope: {scopedResult.scope.tenantId} / {scopedResult.scope.venueId} ·{' '}
              {scopedResult.scope.venueName}
            </p>
            {scopedResult.manifestHash ? (
              <p className="mt-1 break-all font-mono text-xs">
                Manifest hash: {scopedResult.manifestHash}
              </p>
            ) : null}
          </div>
          {scopedResult.materialization ? (
            <>
              <dl className="grid gap-3 rounded-xl border border-pf-light bg-white p-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
                    Native artifact type
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-pf-deep">
                    Venue Deployment Manifest v2
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
                    Package type
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-pf-deep">
                    {scopedResult.materialization.baseManifestHash === null ? 'FULL' : 'PATCH'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pf-deep/70">
                    Materialization status
                  </dt>
                  <dd className="mt-1 text-sm font-semibold text-pf-deep">
                    {scopedResult.materialization.status.replaceAll('_', ' ')}
                  </dd>
                </div>
              </dl>
              <dl
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                aria-label="Materialization coverage"
              >
                {COVERAGE_SECTIONS.map((section) => (
                  <div key={section} className="rounded-xl border border-pf-light bg-white p-3">
                    <dt className="text-xs font-semibold text-pf-deep/70">
                      {section.replaceAll('_', ' ')}
                    </dt>
                    <dd className="mt-1 font-semibold text-pf-deep">
                      {scopedResult.materialization!.coverage[section]}
                    </dd>
                  </div>
                ))}
              </dl>
              <IssueList
                title="Materialization issues"
                items={visibleIssues}
                empty="No materialization issues."
                tone={issues.some((issue) => issue.severity === 'ERROR') ? 'error' : 'warning'}
              />
              {visibleIssueCount < issues.length ? (
                <div className="rounded-xl border border-pf-light bg-white p-4">
                  <p className="text-sm text-pf-deep/75">
                    Showing {visibleIssues.length} of {issues.length} issues.{' '}
                    {issues.length - visibleIssues.length} remaining.
                  </p>
                  <button
                    type="button"
                    className="mt-2 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary"
                    onClick={() =>
                      setVisibleIssueCount((count) =>
                        Math.min(count + INITIAL_VISIBLE_ISSUES, issues.length),
                      )
                    }
                  >
                    Show next{' '}
                    {Math.min(INITIAL_VISIBLE_ISSUES, issues.length - visibleIssues.length)} issues
                  </button>
                </div>
              ) : null}
              <div className="rounded-xl border border-pf-light bg-white p-4">
                <p className="text-sm text-pf-deep/75">
                  {scopedResult.materialization.status === 'MATERIALIZABLE'
                    ? 'Recording a supported PATCH preserves immutable evidence and atomically creates or replays its linked compatibility DRAFT. It never approves or applies the package.'
                    : 'Recording this gated manifest preserves immutable review evidence only. It does not create or apply a venue package.'}
                </p>
                <button
                  type="button"
                  disabled={artifactBusy}
                  onClick={() => void recordArtifact()}
                  className="mt-3 min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {artifactBusy
                    ? 'Recording…'
                    : scopedResult.materialization.status === 'MATERIALIZABLE'
                      ? 'Record artifact and linked DRAFT'
                      : 'Record immutable review artifact'}
                </button>
                {artifactNotice ? (
                  <p className="mt-3 text-sm text-pf-deep" role="status">
                    {artifactNotice}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <IssueList
              title="Validation issues"
              items={visibleIssues}
              empty="No issues."
              tone="error"
            />
          )}
          {scopedResult.materialization?.status === 'MATERIALIZABLE' && scopedResult.handoff ? (
            <section className="rounded-2xl border border-pf-light bg-white p-5">
              <h3 className="font-semibold text-pf-deep">Lifecycle handoff</h3>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {Object.entries(scopedResult.handoff).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-pf-deep/75">{key}</dt>
                    <dd className="font-mono text-xs text-pf-deep">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {scopedResult.materialization?.status === 'MATERIALIZABLE' ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <JsonShape
                title="Exact venuePackage.preview input"
                value={scopedResult.previewInput}
              />
              <JsonShape
                title="Exact venuePackage.createDraft input"
                value={scopedResult.draftInput}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function IssueList({
  title,
  items,
  empty,
  tone,
}: {
  title: string
  items: { code: string; path: string; message: string }[]
  empty: string
  tone: 'error' | 'warning'
}) {
  return (
    <section className="rounded-2xl border border-pf-light bg-white p-5">
      <h3 className="font-semibold text-pf-deep">
        {title} ({items.length})
      </h3>
      {items.length ? (
        <ul className="mt-3 space-y-3">
          {items.map((item, index) => (
            <li
              key={`${item.code}:${item.path}:${index}`}
              className={`rounded-xl p-3 text-sm ${tone === 'error' ? 'bg-rose-50 text-rose-900' : 'bg-amber-50 text-amber-950'}`}
            >
              <p className="font-semibold">{item.code}</p>
              <p className="mt-1 font-mono text-xs">{item.path || '(root)'}</p>
              <p className="mt-1">{item.message}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-pf-deep/75">{empty}</p>
      )}
    </section>
  )
}
function JsonShape({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="min-w-0 rounded-2xl border border-pf-light bg-white p-5">
      <h3 className="font-semibold text-pf-deep">{title}</h3>
      {value ? (
        <pre
          className="mt-3 max-h-96 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-5 text-slate-100"
          tabIndex={0}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <p className="mt-3 text-sm text-pf-deep/75">
          Unavailable until all conversion errors are resolved.
        </p>
      )}
    </section>
  )
}
