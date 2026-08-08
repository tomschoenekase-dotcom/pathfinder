'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'

import { KnowledgeEntryInput, PlaceInput } from '@pathfinder/api/schemas'

import { createTRPCClient } from '../lib/trpc'
import {
  clearVenueContentImportAttempt,
  getOrCreateVenueContentImportAttempt,
} from '../lib/venue-import-idempotency'

type GuideMode = 'location_aware' | 'non_location'

type ImportIssue = {
  message: string
  severity: 'error' | 'warning'
}

type ParsedImport = {
  places: Array<ReturnType<typeof PlaceInput.parse>>
  knowledgeEntries: Array<ReturnType<typeof KnowledgeEntryInput.parse>>
  issues: ImportIssue[]
}

type VenueJsonImporterProps = {
  venueId: string
  venueName: string
  guideMode: GuideMode
}

const EXAMPLE_JSON = `{
  "schemaVersion": 1,
  "places": [
    {
      "title": "Butterfly Conservatory",
      "type": "exhibit",
      "itemType": "exhibit",
      "description": "A warm indoor habitat with free-flying butterflies.",
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
      "content": "Wheelchair-accessible entrances are available at the main gate."
    }
  ]
}`

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Import completion could not be confirmed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatIssues(issues: { message: string }[]): string {
  return issues.map((issue) => issue.message).join(', ')
}

function parseImport(text: string, guideMode: GuideMode): ParsedImport | null {
  const issues: ImportIssue[] = []
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch {
    return {
      places: [],
      knowledgeEntries: [],
      issues: [{ severity: 'error', message: 'The file is not valid JSON.' }],
    }
  }

  if (!isRecord(raw)) {
    return {
      places: [],
      knowledgeEntries: [],
      issues: [{ severity: 'error', message: 'The JSON root must be an object.' }],
    }
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    issues.push({ severity: 'error', message: 'schemaVersion must be 1.' })
  }

  const rawPlaces = raw.places
  const rawKnowledgeEntries = raw.knowledgeEntries
  if (rawPlaces !== undefined && !Array.isArray(rawPlaces)) {
    issues.push({ severity: 'error', message: 'places must be an array.' })
  }
  if (rawKnowledgeEntries !== undefined && !Array.isArray(rawKnowledgeEntries)) {
    issues.push({ severity: 'error', message: 'knowledgeEntries must be an array.' })
  }

  const places = Array.isArray(rawPlaces)
    ? rawPlaces.flatMap((item, index) => {
        if (!isRecord(item)) {
          issues.push({ severity: 'error', message: `Guide item ${index + 1} must be an object.` })
          return []
        }

        const candidate = {
          name: item.title ?? item.name,
          type:
            item.type ??
            (guideMode === 'non_location' ? (item.itemType ?? 'general_info') : undefined),
          itemType: item.itemType,
          shortDescription: item.shortDescription,
          longDescription: item.description ?? item.longDescription,
          lat: item.lat,
          lng: item.lng,
          tags: item.tags,
          importanceScore: item.importanceScore,
          areaName: item.areaName,
          hours: item.hours,
          photoUrl: item.photoUrl,
        }
        const parsed = PlaceInput.safeParse(candidate)
        const label =
          typeof candidate.name === 'string' && candidate.name
            ? candidate.name
            : `Guide item ${index + 1}`

        if (!parsed.success) {
          issues.push({
            severity: 'error',
            message: `${label}: ${formatIssues(parsed.error.issues)}`,
          })
          return []
        }
        if (
          guideMode === 'location_aware' &&
          (parsed.data.lat === undefined || parsed.data.lng === undefined)
        ) {
          issues.push({
            severity: 'error',
            message: `${label}: latitude and longitude are required for this venue.`,
          })
          return []
        }
        if ((parsed.data.lat === undefined) !== (parsed.data.lng === undefined)) {
          issues.push({
            severity: 'error',
            message: `${label}: latitude and longitude must be supplied together.`,
          })
          return []
        }
        if (parsed.data.longDescription === undefined) {
          issues.push({
            severity: 'warning',
            message: `${label}: no description will be imported.`,
          })
        }
        return [parsed.data]
      })
    : []

  const knowledgeEntries = Array.isArray(rawKnowledgeEntries)
    ? rawKnowledgeEntries.flatMap((item, index) => {
        if (!isRecord(item)) {
          issues.push({
            severity: 'error',
            message: `Knowledge entry ${index + 1} must be an object.`,
          })
          return []
        }
        const parsed = KnowledgeEntryInput.safeParse({
          title: item.title,
          category: item.category,
          content: item.content,
          isEnabled: item.isEnabled,
        })
        if (!parsed.success) {
          issues.push({
            severity: 'error',
            message: `Knowledge entry ${index + 1}: ${formatIssues(parsed.error.issues)}`,
          })
          return []
        }
        return [parsed.data]
      })
    : []

  if (
    places.length === 0 &&
    knowledgeEntries.length === 0 &&
    !issues.some((issue) => issue.severity === 'error')
  ) {
    issues.push({
      severity: 'error',
      message: 'Include at least one guide item or knowledge entry.',
    })
  }

  return { places, knowledgeEntries, issues }
}

export function VenueJsonImporter({ venueId, venueName, guideMode }: VenueJsonImporterProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current
  const importAttemptRef = useRef<Awaited<
    ReturnType<typeof getOrCreateVenueContentImportAttempt>
  > | null>(null)

  const [jsonText, setJsonText] = useState('')
  const [parsedImport, setParsedImport] = useState<ParsedImport | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  function validate(text: string) {
    importAttemptRef.current = null
    setJsonText(text)
    setSubmitError(null)
    setSuccessMessage(null)
    setParsedImport(parseImport(text, guideMode))
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    validate(await file.text())
    event.target.value = ''
  }

  async function handleImport() {
    if (!parsedImport || parsedImport.issues.some((issue) => issue.severity === 'error')) return

    setIsImporting(true)
    setSubmitError(null)
    try {
      const payload = {
        venueId,
        places: parsedImport.places,
        knowledgeEntries: parsedImport.knowledgeEntries,
      }
      const attempt =
        importAttemptRef.current ?? (await getOrCreateVenueContentImportAttempt(payload))
      importAttemptRef.current = attempt
      const result = await client.venue.importContent.mutate({
        ...payload,
        idempotencyKey: attempt.idempotencyKey,
      })
      setSuccessMessage(
        `Imported ${result.placeCount} guide items and ${result.knowledgeEntryCount} knowledge entries.`,
      )
      setJsonText('')
      setParsedImport(null)
      clearVenueContentImportAttempt(venueId, attempt)
      importAttemptRef.current = null
      router.refresh()
    } catch (error) {
      setSubmitError(
        `${getErrorMessage(error)} Retry this unchanged import safely; PathFinder will reuse its attempt identity.`,
      )
    } finally {
      setIsImporting(false)
    }
  }

  const errorCount = parsedImport?.issues.filter((issue) => issue.severity === 'error').length ?? 0
  const warningCount =
    parsedImport?.issues.filter((issue) => issue.severity === 'warning').length ?? 0
  const canImport =
    parsedImport !== null &&
    errorCount === 0 &&
    (parsedImport.places.length > 0 || parsedImport.knowledgeEntries.length > 0)

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-pf-deep">Import venue content</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          Import guide items and knowledge entries for {venueName}. A guide item&apos;s{' '}
          <code>title</code> becomes its name, and <code>description</code> becomes its long
          description.
        </p>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          This venue is{' '}
          {guideMode === 'location_aware'
            ? 'location-aware, so every guide item needs latitude and longitude.'
            : 'not location-aware, so coordinates are optional.'}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-11 cursor-pointer items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5">
            Choose JSON file
            <input
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={handleFileChange}
            />
          </label>
          <button
            type="button"
            onClick={() => validate(EXAMPLE_JSON)}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
          >
            Load example
          </button>
        </div>

        <label className="mt-5 block text-sm font-medium text-pf-deep/70" htmlFor="venue-json">
          JSON content
        </label>
        <textarea
          id="venue-json"
          value={jsonText}
          onChange={(event) => validate(event.target.value)}
          placeholder="Paste your venue JSON here"
          spellCheck={false}
          className="mt-2 min-h-96 w-full rounded-lg border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
      </section>

      {parsedImport ? (
        <section className="rounded-2xl border border-pf-light bg-pf-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-pf-deep">Import preview</h2>
              <p className="mt-1 text-sm text-pf-deep/60">
                {parsedImport.places.length} guide items and {parsedImport.knowledgeEntries.length}{' '}
                knowledge entries ready.
              </p>
            </div>
            <button
              type="button"
              disabled={!canImport || isImporting}
              onClick={() => void handleImport()}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light"
            >
              {isImporting ? 'Importing...' : 'Import content'}
            </button>
          </div>

          {errorCount > 0 || warningCount > 0 ? (
            <div className="mt-5 space-y-2">
              {parsedImport.issues.map((issue, index) => (
                <p
                  key={`${issue.severity}-${index}`}
                  className={`rounded-lg border px-4 py-3 text-sm ${issue.severity === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
                >
                  {issue.message}
                </p>
              ))}
            </div>
          ) : null}
          {submitError ? (
            <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {submitError}
            </p>
          ) : null}
        </section>
      ) : null}

      {successMessage ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {successMessage}
        </p>
      ) : null}
    </div>
  )
}
