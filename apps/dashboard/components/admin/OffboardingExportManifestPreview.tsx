'use client'

import { useEffect, useRef, useState } from 'react'

import type { OffboardingExportManifestPreview as Preview } from '@pathfinder/contracts/offboarding-export-preview'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const EXPORT_PREVIEW_TIMEOUT_MS = 15_000

export function OffboardingExportManifestPreview({
  tenantId,
  venues,
}: {
  tenantId: string
  venues: { id: string; name: string }[]
}) {
  const client = useTRPCClient()
  const active = useRef(false)
  const requestSequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const [venueIds, setVenueIds] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = `${tenantId}:${venueIds.join(',')}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  useEffect(() => {
    requestSequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    active.current = false
    setVenueIds([])
    setPreview(null)
    setPending(false)
    setError(null)
  }, [tenantId])

  useEffect(
    () => () => {
      requestSequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    },
    [],
  )

  async function loadPreview() {
    if (active.current || venueIds.length === 0) return
    const startedSequence = ++requestSequence.current
    const startedScope = scope
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    active.current = true
    setPending(true)
    setError(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: EXPORT_PREVIEW_TIMEOUT_MS,
        request: (signal) =>
          client.admin.previewOffboardingExportManifest.query(
            {
              tenantId,
              venueIds,
            },
            { signal },
          ),
      })
      if (requestSequence.current === startedSequence && currentScope.current === startedScope) {
        setPreview(result)
      }
    } catch {
      if (requestSequence.current === startedSequence && currentScope.current === startedScope) {
        setError(
          'The preview could not be loaded in time. No export artifact or offboarding action was created. Retry when ready.',
        )
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (requestSequence.current === startedSequence && currentScope.current === startedScope) {
        active.current = false
        setPending(false)
      }
    }
  }

  function toggle(venueId: string, checked: boolean) {
    requestSequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    active.current = false
    setPending(false)
    setVenueIds((current) =>
      checked ? [...current, venueId] : current.filter((id) => id !== venueId),
    )
    setPreview(null)
    setError(null)
  }

  return (
    <section
      id="export-manifest-preview"
      aria-labelledby="export-preview-title"
      className="rounded-2xl border border-pf-light bg-white p-5 sm:p-6"
    >
      <h3 id="export-preview-title" className="text-lg font-semibold text-pf-deep">
        Export-manifest preview
      </h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/75">
        Preview metadata references for up to 20 venues. This does not create, store, download, or
        execute an export and cannot revoke or delete anything.
      </p>
      {venues.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/75">No venues are available.</p>
      ) : (
        <fieldset className="mt-4" disabled={pending}>
          <legend className="text-sm font-semibold text-pf-deep">Selected venues</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {venues.map((venue) => (
              <label
                key={venue.id}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-pf-light px-3 text-sm text-pf-deep"
              >
                <input
                  type="checkbox"
                  checked={venueIds.includes(venue.id)}
                  disabled={!venueIds.includes(venue.id) && venueIds.length >= 20}
                  onChange={(event) => toggle(venue.id, event.target.checked)}
                />
                {venue.name}
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void loadPreview()}
            disabled={venueIds.length === 0 || pending}
            className="mt-4 min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {pending ? 'Loading preview…' : 'Preview manifest metadata'}
          </button>
        </fieldset>
      )}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {preview ? <ManifestSummary preview={preview} /> : null}
    </section>
  )
}

function ManifestSummary({ preview }: { preview: Preview }) {
  const truncated = Object.entries(preview.truncation).filter(([, evidence]) => evidence.truncated)
  return (
    <div className="mt-6 space-y-5 border-t border-pf-light pt-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-pf-primary">
          Preview only · schema v{preview.schemaVersion}
        </p>
        <p className="mt-1 text-sm text-pf-deep/75">
          Privacy boundary: metadata and references only. Generated{' '}
          {new Date(preview.generatedAt).toLocaleString()}.
        </p>
      </div>
      {truncated.length ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
        >
          This preview is truncated:{' '}
          {truncated
            .map(([name, evidence]) => `${name} ${evidence.returned}/${evidence.available}`)
            .join(', ')}
          .
        </div>
      ) : (
        <p role="status" className="text-sm text-emerald-700">
          All available references fit within preview caps.
        </p>
      )}
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Venues', preview.venues.length],
          ['Current content', preview.currentContent.length],
          ['History', preview.contentHistory.length],
          ['Packages', preview.packages.length],
          ['Module revisions', preview.revisions.length],
          ['Evidence refs', preview.evidence.length],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl bg-pf-surface p-3">
            <dt className="text-xs text-pf-deep/75">{label}</dt>
            <dd className="mt-1 text-xl font-semibold text-pf-deep">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-4 xl:grid-cols-2">
        <ReferenceList
          title="Venue identities"
          items={preview.venues.map(
            (venue) => `${venue.name} · ${venue.id} · ${venue.isActive ? 'active' : 'inactive'}`,
          )}
        />
        <ReferenceList
          title="Venue packages"
          items={preview.packages.map(
            (item) => `${item.id} · ${item.status} · ${item.payloadHash.slice(0, 12)}…`,
          )}
        />
        <ReferenceList
          title="Normalized modules"
          items={preview.modules.map((item) => `${item.id} · ${item.kind}`)}
        />
        <ReferenceList
          title="Evidence references"
          items={preview.evidence.map((item) => `${item.id} · revision ${item.revisionId}`)}
        />
      </div>
    </div>
  )
}

function ReferenceList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-pf-deep">{title}</h4>
      {items.length ? (
        <ul
          tabIndex={0}
          aria-label={title}
          className="mt-2 max-h-52 space-y-1 overflow-auto rounded-xl border border-pf-light p-3 text-xs text-pf-deep/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-pf-deep/75">No references.</p>
      )}
    </div>
  )
}
