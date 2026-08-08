'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import type { VenuePackagePayload, VenuePackageStoredPreview } from '@pathfinder/api'

import { createTRPCClient } from '../lib/trpc'

type Client = ReturnType<typeof createTRPCClient>
type Preview = VenuePackageStoredPreview
type PackageRecord = Awaited<ReturnType<Client['venuePackage']['list']['query']>>[number]

type VenueJsonImporterProps = {
  venueId: string
  venueName: string
  guideMode: 'location_aware' | 'non_location'
  canPublish?: boolean
}

const EXAMPLE_JSON = `{
  "schemaVersion": 1,
  "places": [
    {
      "name": "Butterfly Conservatory",
      "type": "exhibit",
      "itemType": "exhibit",
      "shortDescription": "A warm indoor habitat with free-flying butterflies.",
      "lat": 41.8812,
      "lng": -87.6237,
      "tags": ["family", "indoor"],
      "importanceScore": 80,
      "areaName": "North Wing",
      "hours": "10 AM - 5 PM"
    }
  ],
  "knowledgeEntries": [
    {
      "title": "Accessibility",
      "category": "Accessibility",
      "content": "Wheelchair-accessible entrances are available at the main gate.",
      "isEnabled": true
    }
  ]
}`

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The venue-package action could not be confirmed.'
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function statusClass(status: PackageRecord['status']) {
  if (status === 'APPLIED') return 'bg-green-100 text-green-800'
  if (status === 'APPROVED') return 'bg-blue-100 text-blue-800'
  if (status === 'REVERTED') return 'bg-gray-100 text-gray-700'
  return 'bg-amber-100 text-amber-800'
}

function venueConfigValue(value: string | null, isAfter = false): string {
  if (value === null) return isAfter ? 'null (clear)' : 'null'
  return JSON.stringify(value)
}

export function VenueJsonImporter({
  venueId,
  venueName,
  guideMode,
  canPublish = true,
}: VenueJsonImporterProps) {
  const client = useMemo(() => createTRPCClient(), [])
  const [text, setText] = useState(EXAMPLE_JSON)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [packages, setPackages] = useState<PackageRecord[]>([])
  const [selected, setSelected] = useState<PackageRecord | null>(null)
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID())
  const [selectedIsStale, setSelectedIsStale] = useState(false)
  const commandKeys = useRef(new Map<string, string>())

  async function loadPackages(preferredId?: string) {
    const rows = await client.venuePackage.list.query({ venueId })
    setPackages(rows)
    if (preferredId) {
      const preferred = rows.find((row) => row.id === preferredId) ?? null
      setSelected(preferred)
      setPreview(preferred?.previewPlan ?? null)
      setWarningsAcknowledged(false)
    }
    return rows
  }

  useEffect(() => {
    void loadPackages().catch((cause) => setError(errorMessage(cause)))
    // The typed client is stable for this component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId])

  function parseText(): VenuePackagePayload {
    try {
      return JSON.parse(text) as VenuePackagePayload
    } catch {
      throw new Error('The package is not valid JSON.')
    }
  }

  async function runPreview(payload = parseText()) {
    const next = await client.venuePackage.preview.mutate({ venueId, payload })
    setPreview(next)
    setWarningsAcknowledged(false)
    return next
  }

  async function handlePreview() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await runPreview()
    } catch (cause) {
      setPreview(null)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveDraft() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const payload = parseText()
      const checked = await runPreview(payload)
      if (checked.report.errors.length > 0) throw new Error('Resolve every preview error first.')
      const draft = await client.venuePackage.createDraft.mutate({ venueId, payload, draftKey })
      await loadPackages(draft.id)
      setPreview(draft.preview)
      setDraftKey(crypto.randomUUID())
      setNotice(draft.replayed ? 'This exact draft already exists.' : 'Draft saved for review.')
    } catch (cause) {
      // A terminal analysis receipt deliberately cannot be redriven because the
      // provider has no idempotency boundary. Give an unchanged payload a fresh
      // identity only when the server explicitly requires one; retain the key
      // for ambiguous/transient failures so response-loss replay remains safe.
      if (errorCode(cause) === 'PRECONDITION_FAILED') setDraftKey(crypto.randomUUID())
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function refreshConflict(packageId: string) {
    const rows = await loadPackages(packageId)
    const current = rows.find((row) => row.id === packageId)
    if (current) {
      setText(JSON.stringify(current.payload, null, 2))
      setPreview(current.previewPlan)
      setWarningsAcknowledged(false)
    }
    setNotice('Package or venue content changed. The current revision was refreshed for review.')
  }

  async function runLifecycle(action: 'approve' | 'apply' | 'revert') {
    if (!selected) return
    if (action === 'approve' && preview?.report.warnings.length && !warningsAcknowledged) {
      setError('Acknowledge every warning before approval.')
      return
    }
    if (
      action === 'revert' &&
      !window.confirm('Revert every unchanged item created by this package?')
    ) {
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const commandIdentity = `${selected.id}:${action}:${selected.updatedAt.toISOString()}`
      const commandKey = commandKeys.current.get(commandIdentity) ?? crypto.randomUUID()
      commandKeys.current.set(commandIdentity, commandKey)
      const input = { id: selected.id, expectedUpdatedAt: selected.updatedAt, commandKey }
      const result =
        action === 'approve'
          ? await client.venuePackage.approve.mutate({
              ...input,
              acknowledgedWarningDigest: preview?.warningDigest ?? '',
              acknowledgedPayloadHash: preview?.payloadHash ?? '',
            })
          : action === 'apply'
            ? await client.venuePackage.applyPackage.mutate(input)
            : await client.venuePackage.revertPackage.mutate(input)
      await loadPackages(result.id)
      setNotice(
        action === 'approve'
          ? 'Package approved. Application remains a separate action.'
          : action === 'apply'
            ? 'Package applied atomically.'
            : 'Package reverted to its exact approved base.',
      )
    } catch (cause) {
      const message = errorMessage(cause)
      if (/conflict|changed|refresh|already applied/i.test(message)) {
        setSelectedIsStale(true)
        try {
          await refreshConflict(selected.id)
        } catch {
          setNotice(
            'The action conflicted, and automatic refresh also failed. Reload before retrying.',
          )
        }
      }
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  function selectPackage(pkg: PackageRecord) {
    setSelected(pkg)
    setText(JSON.stringify(pkg.payload, null, 2))
    setPreview(pkg.previewPlan)
    setWarningsAcknowledged(false)
    setSelectedIsStale(false)
    setError(null)
    setNotice(null)
  }

  const warningCount = preview?.report.warnings.length ?? 0
  const semanticScanComplete = preview?.report.semanticDuplicateScan.status === 'COMPLETE'

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Venue package workspace</h2>
        <p className="mt-1 text-sm text-gray-600">
          {venueName} ·{' '}
          {guideMode === 'location_aware' ? 'Location-aware guide' : 'Non-location guide'}
        </p>
        <p className="mt-2 text-sm text-gray-600">
          Schema v1 is additive and supports only places and knowledge entries. Unknown sections and
          nested fields are rejected by the server instead of being discarded.
        </p>

        <label
          className="mt-5 block text-sm font-medium text-gray-700"
          htmlFor="venue-package-json"
        >
          Canonical package JSON
        </label>
        <textarea
          id="venue-package-json"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setDraftKey(crypto.randomUUID())
            setPreview(null)
            setSelected(null)
            setWarningsAcknowledged(false)
          }}
          rows={22}
          className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          spellCheck={false}
        />
        <input
          type="file"
          accept="application/json,.json"
          className="mt-3 block text-sm text-gray-600"
          aria-label="Load venue package JSON file"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            void file.text().then((contents) => {
              setText(contents)
              setDraftKey(crypto.randomUUID())
              setPreview(null)
              setSelected(null)
              setWarningsAcknowledged(false)
            })
          }}
        />

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={busy}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            Preview on server
          </button>
          <button
            type="button"
            onClick={() => void handleSaveDraft()}
            disabled={busy || !preview || preview.report.errors.length > 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Save immutable draft
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-4 text-sm text-green-700">
            {notice}
          </p>
        )}
      </section>

      {preview && (
        <section className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">
                {preview.schemaVersion === 2
                  ? 'Exact venue configuration patch + additive preview'
                  : 'Exact additive preview'}
              </h3>
              <p className="mt-1 font-mono text-xs text-gray-500">{preview.payloadHash}</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
              Mode: {preview.mode}
            </span>
          </div>

          {preview.report.errors.length > 0 && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4">
              <h4 className="text-sm font-semibold text-red-800">Errors</h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
                {preview.report.errors.map((issue) => (
                  <li key={`${issue.path}-${issue.code}`}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div
            className={`mt-4 rounded-md border p-4 ${
              preview.report.semanticDuplicateScan.status === 'COMPLETE'
                ? 'border-green-200 bg-green-50'
                : preview.report.semanticDuplicateScan.status === 'INCOMPLETE'
                  ? 'border-red-200 bg-red-50'
                  : 'border-blue-200 bg-blue-50'
            }`}
          >
            <h4 className="text-sm font-semibold text-gray-900">
              Semantic duplicate scan: {preview.report.semanticDuplicateScan.status}
            </h4>
            {(['places', 'knowledgeEntries'] as const).map((scopeName) => {
              const scope = preview.report.semanticDuplicateScan.scopes[scopeName]
              return (
                <p key={scopeName} className="mt-1 text-xs text-gray-700">
                  {scopeName === 'places' ? 'Places' : 'Knowledge'}: {scope.scannedInputCount}/
                  {scope.inputCount} draft items and {scope.scannedExistingCount}/
                  {scope.existingCount} existing items compared.
                </p>
              )
            })}
            {preview.report.semanticDuplicateScan.status === 'NOT_RUN' && (
              <p className="mt-2 text-sm text-blue-800">
                The semantic scan runs when this preview is saved as an immutable draft.
              </p>
            )}
            {preview.report.semanticDuplicateScan.status === 'INCOMPLETE' && (
              <p className="mt-2 text-sm text-red-800">
                This draft is retained as evidence but cannot be approved or applied. Repair
                embeddings, then save a new draft.
              </p>
            )}
          </div>

          {warningCount > 0 && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
              <h4 className="text-sm font-semibold text-amber-800">Warnings</h4>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700">
                {preview.report.warnings.map((issue) => (
                  <li key={`${issue.path}-${issue.code}`}>
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
              <label className="mt-3 flex items-center gap-2 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={warningsAcknowledged}
                  onChange={(event) => setWarningsAcknowledged(event.target.checked)}
                />
                I reviewed all {warningCount} warning{warningCount === 1 ? '' : 's'}.
              </label>
            </div>
          )}

          {preview.schemaVersion === 2 && (
            <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50 p-4">
              <h4 className="text-sm font-semibold text-indigo-900">
                Venue configuration changes ({preview.changes.venue.change.length})
              </h4>
              {preview.changes.venue.change.length === 0 ? (
                <p className="mt-2 text-sm text-indigo-800">
                  No venue configuration fields change.
                </p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm text-indigo-900">
                  {preview.changes.venue.change.map((change) => (
                    <li key={change.path} className="rounded bg-white/70 p-2">
                      <code className="block text-xs font-semibold">{change.path}</code>
                      <span className="mt-1 block font-mono text-xs">
                        {venueConfigValue(change.before)} → {venueConfigValue(change.after, true)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-indigo-700">
                {preview.changes.venue.unchanged} venue configuration fields unchanged.
              </p>
              {preview.changes.venue.change.some(
                (change) =>
                  change.path === 'venue.branding.chatLogoUrl' ||
                  change.path === 'venue.branding.chatBannerUrl',
              ) && (
                <p className="mt-2 text-xs text-indigo-800">
                  Branding URL fields are compatible external URL references. This package does not
                  upload, copy, or host image assets.
                </p>
              )}
            </div>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-md border border-gray-200 p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Places to add ({preview.changes.places.add.length})
              </h4>
              <ul className="mt-2 space-y-1 text-sm text-gray-700">
                {preview.changes.places.add.map((place, index) => (
                  <li key={`${place.name}-${index}`} className="rounded bg-gray-50 p-2">
                    <pre className="whitespace-pre-wrap text-xs">
                      {JSON.stringify(place, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                {preview.changes.places.unchanged} existing places unchanged; 0 changed; 0 removed.
              </p>
            </div>
            <div className="rounded-md border border-gray-200 p-4">
              <h4 className="text-sm font-semibold text-gray-900">
                Knowledge to add ({preview.changes.knowledgeEntries.add.length})
              </h4>
              <ul className="mt-2 space-y-1 text-sm text-gray-700">
                {preview.changes.knowledgeEntries.add.map((entry, index) => (
                  <li key={`${entry.title}-${index}`} className="rounded bg-gray-50 p-2">
                    <pre className="whitespace-pre-wrap text-xs">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                {preview.changes.knowledgeEntries.unchanged} existing entries unchanged; 0 changed;
                0 removed.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="font-semibold text-gray-900">Durable package history</h3>
        {packages.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">No saved package revisions yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {packages.map((pkg) => (
              <div key={pkg.id} className="rounded-md border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button type="button" className="text-left" onClick={() => selectPackage(pkg)}>
                    <span className="font-mono text-xs text-gray-500">{pkg.id}</span>
                    <span
                      className={`ml-3 rounded-full px-2 py-1 text-xs font-medium ${statusClass(pkg.status)}`}
                    >
                      {pkg.status}
                    </span>
                    <span className="ml-3 text-xs text-gray-500">
                      {new Date(pkg.createdAt).toLocaleString()}
                    </span>
                  </button>
                  {selected?.id === pkg.id && (
                    <div className="flex flex-wrap gap-2">
                      {pkg.status === 'DRAFT' && canPublish && (
                        <button
                          type="button"
                          onClick={() => void runLifecycle('approve')}
                          disabled={
                            busy ||
                            !preview ||
                            !semanticScanComplete ||
                            preview.report.errors.length > 0 ||
                            (warningCount > 0 && !warningsAcknowledged)
                          }
                          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                      {pkg.status === 'APPROVED' && canPublish && (
                        <button
                          type="button"
                          onClick={() => void runLifecycle('apply')}
                          disabled={
                            busy ||
                            selectedIsStale ||
                            !preview ||
                            !semanticScanComplete ||
                            preview.report.errors.length > 0
                          }
                          className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                        >
                          Apply approved package
                        </button>
                      )}
                      {pkg.status === 'APPLIED' && canPublish && (
                        <button
                          type="button"
                          onClick={() => void runLifecycle('revert')}
                          disabled={busy}
                          className="rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
                        >
                          Revert package
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
