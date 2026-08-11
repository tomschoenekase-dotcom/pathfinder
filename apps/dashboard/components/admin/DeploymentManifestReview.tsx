'use client'

import { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type ReviewResult = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['reviewDeploymentManifest']['query']>
>

export function DeploymentManifestReview({
  tenantId,
  venueId,
}: {
  tenantId: string
  venueId: string
}) {
  const client = useTRPCClient()
  const [manifestJson, setManifestJson] = useState('')
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  async function review() {
    if (running.current || !manifestJson.trim()) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      setResult(
        await client.admin.reviewDeploymentManifest.query({ tenantId, venueId, manifestJson }),
      )
    } catch {
      setError(
        'The review could not be completed. The manifest text is preserved; no package or venue data was changed.',
      )
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const errors = result?.issues.filter((issue) => issue.severity === 'ERROR') ?? []
  const warnings = result?.issues.filter((issue) => issue.severity === 'WARNING') ?? []
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-pf-primary">
          Internal review only
        </p>
        <h2 className="mt-1 text-2xl font-semibold text-pf-deep">Venue Deployment Manifest v2</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Validate a PATCH manifest and inspect its exact handoff into the existing VenuePackage
          lifecycle. This tool never creates a draft, approves, applies, rolls back, queues, or
          persists anything.
        </p>
        <label className="mt-5 block text-sm font-semibold text-pf-deep">
          Manifest JSON
          <textarea
            aria-label="Manifest JSON"
            value={manifestJson}
            onChange={(event) => setManifestJson(event.target.value)}
            maxLength={250000}
            spellCheck={false}
            className="mt-2 min-h-72 w-full rounded-2xl border border-pf-light bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
            placeholder="Paste one Venue Deployment Manifest v2 JSON object."
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !manifestJson.trim()}
            onClick={() => void review()}
            className="min-h-11 rounded-2xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {busy ? 'Reviewing…' : 'Review manifest'}
          </button>
          <span className="text-xs text-pf-deep/75">
            Maximum 250,000 characters. Submitted text is not persisted.
          </span>
        </div>
        {error ? (
          <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {result ? (
        <section className="space-y-5" aria-label="Manifest conversion review">
          <div
            className={`rounded-2xl border p-4 ${result.compatible ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}
            role="status"
          >
            <p className="font-semibold">
              {result.compatible
                ? 'Compatible with the existing preview handoff'
                : 'Not compatible with the existing package lifecycle'}
            </p>
            <p className="mt-1 text-xs">
              Scope: {result.scope.tenantId} / {result.scope.venueId} · {result.scope.venueName}
            </p>
            {result.manifestHash ? (
              <p className="mt-1 break-all font-mono text-xs">
                Manifest hash: {result.manifestHash}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <IssueList title="Errors" items={errors} empty="No conversion errors." tone="error" />
            <IssueList
              title="Warnings"
              items={warnings}
              empty="No conversion warnings."
              tone="warning"
            />
          </div>
          {result.handoff ? (
            <section className="rounded-2xl border border-pf-light bg-white p-5">
              <h3 className="font-semibold text-pf-deep">Lifecycle handoff</h3>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                {Object.entries(result.handoff).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-pf-deep/75">{key}</dt>
                    <dd className="font-mono text-xs text-pf-deep">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <div className="grid gap-4 xl:grid-cols-2">
            <JsonShape title="Exact venuePackage.preview input" value={result.previewInput} />
            <JsonShape title="Exact venuePackage.createDraft input" value={result.draftInput} />
          </div>
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
