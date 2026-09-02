'use client'

import Link from 'next/link'
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, ShieldCheck } from 'lucide-react'
import * as XLSX from 'xlsx'

import { uploadProspectWorkbook } from '../../lib/prospect-workbook-upload'
import {
  runProspectImportRequest,
  throwIfProspectImportPollingCancelled,
  waitForProspectImportPoll,
} from '../../lib/prospect-import-polling'
import { useTRPCClient } from '../../lib/trpc'
import { inspectXlsxArchive, XlsxArchivePreflightError } from '../../lib/xlsx-archive-preflight'

const FIELD_DEFINITIONS = [
  ['venueName', 'Venue name', true, 'venue_name'],
  ['organizationName', 'Parent organization', false, 'owner_name'],
  ['venueType', 'Venue type', false, 'venue_type'],
  ['venueSubtype', 'Venue subtype', false, 'venue_subtype'],
  ['city', 'City', false, 'city'],
  ['region', 'State / region', false, 'state'],
  ['website', 'Website', false, 'website'],
  ['generalEmail', 'General email', false, 'general_email'],
  ['contactName', 'Contact name', false, 'contact_name'],
  ['contactTitle', 'Contact title', false, 'contact_title'],
  ['contactEmail', 'Contact email', false, 'contact_email'],
  ['phone', 'Phone', false, 'phone'],
  ['ownerSize', 'Organization size', false, 'owner_size'],
  ['locationCount', 'Location count', false, 'location_count'],
  ['venueSize', 'Venue size', false, 'venue_size'],
  ['shortDescription', 'Description', false, 'short_description'],
  ['fitScore', 'Fit score', false, 'pathfinder_fit_score'],
  ['fitReason', 'Fit reason', false, 'fit_reason'],
  ['primaryUseCase', 'Primary use case', false, 'primary_use_case'],
  ['outreachPriority', 'Outreach priority', false, 'outreach_priority'],
  ['personalizationHook', 'Personalization hook', false, 'personalization_hook'],
  ['researchConfidence', 'Research confidence', false, 'research_confidence'],
  ['researchDate', 'Research date', false, 'research_date'],
  ['sourceUrls', 'Source URLs', false, 'source_urls'],
  ['notes', 'Notes', false, 'notes'],
  ['territory', 'Territory', false, 'territory'],
] as const

type FieldKey = (typeof FIELD_DEFINITIONS)[number][0]
type Mapping = Record<FieldKey, string>
type SheetMeta = { name: string; index: number; rows: number; columns: string[] }
type NormalizedRow = {
  venueName: string
  organizationName?: string | undefined
  venueType?: string | undefined
  venueSubtype?: string | undefined
  city?: string | undefined
  region?: string | undefined
  website?: string | undefined
  generalEmail?: string | undefined
  contactName?: string | undefined
  contactTitle?: string | undefined
  contactEmail?: string | undefined
  phone?: string | undefined
  ownerSize?: string | undefined
  locationCount?: string | undefined
  venueSize?: string | undefined
  shortDescription?: string | undefined
  fitScore?: string | undefined
  fitReason?: string | undefined
  primaryUseCase?: string | undefined
  outreachPriority?: string | undefined
  personalizationHook?: string | undefined
  researchConfidence?: string | undefined
  researchDate?: string | undefined
  sourceUrls?: string[] | undefined
  notes?: string | undefined
  territory?: string | undefined
}
type ImportDetail = {
  prospectImport: {
    id: string
    status: string
    totalRows: number
    validRows: number
    warningRows: number
    duplicateRows: number
    importedRows: number
    failedRows: number
    progressCursor: string | null
    reportHash: string | null
  }
  rows: Array<{
    id: string
    sheetName: string
    originalRowNumber: number
    status: string
    warnings: unknown
    errors: unknown
    duplicateMatches: unknown
    normalizedValues: unknown
    errorMessage: string | null
  }>
}
type ImportHistoryItem = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['admin']['listProspectImports']['query']>
>[number]

function initialMapping(): Mapping {
  return Object.fromEntries(FIELD_DEFINITIONS.map(([key, , , source]) => [key, source])) as Mapping
}

function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}

function mappedRow(
  source: Record<string, unknown>,
  mapping: Mapping,
  sheetName: string,
): NormalizedRow {
  const get = (key: FieldKey) => cellText(source[mapping[key]])
  const sourceUrls = get('sourceUrls')
    ?.split('|')
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 20)
  return {
    venueName: get('venueName') ?? '',
    ...(get('organizationName') ? { organizationName: get('organizationName') } : {}),
    ...(get('venueType') ? { venueType: get('venueType') } : {}),
    ...(get('venueSubtype') ? { venueSubtype: get('venueSubtype') } : {}),
    ...(get('city') ? { city: get('city') } : {}),
    ...(get('region') ? { region: get('region') } : {}),
    ...(get('website') ? { website: get('website') } : {}),
    ...(get('generalEmail') ? { generalEmail: get('generalEmail') } : {}),
    ...(get('contactName') ? { contactName: get('contactName') } : {}),
    ...(get('contactTitle') ? { contactTitle: get('contactTitle') } : {}),
    ...(get('contactEmail') ? { contactEmail: get('contactEmail') } : {}),
    ...(get('phone') ? { phone: get('phone') } : {}),
    ...(get('ownerSize') ? { ownerSize: get('ownerSize') } : {}),
    ...(get('locationCount') ? { locationCount: get('locationCount') } : {}),
    ...(get('venueSize') ? { venueSize: get('venueSize') } : {}),
    ...(get('shortDescription') ? { shortDescription: get('shortDescription') } : {}),
    ...(get('fitScore') ? { fitScore: get('fitScore') } : {}),
    ...(get('fitReason') ? { fitReason: get('fitReason') } : {}),
    ...(get('primaryUseCase') ? { primaryUseCase: get('primaryUseCase') } : {}),
    ...(get('outreachPriority') ? { outreachPriority: get('outreachPriority') } : {}),
    ...(get('personalizationHook') ? { personalizationHook: get('personalizationHook') } : {}),
    ...(get('researchConfidence') ? { researchConfidence: get('researchConfidence') } : {}),
    ...(get('researchDate') ? { researchDate: get('researchDate') } : {}),
    ...(sourceUrls?.length ? { sourceUrls } : {}),
    ...(get('notes') ? { notes: get('notes') } : {}),
    territory: get('territory') ?? sheetName,
  }
}

async function sha256(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function stableMapping(mapping: Mapping, selectedSheets: string[]) {
  return JSON.stringify({
    version: 1,
    mapping: Object.fromEntries(Object.entries(mapping).sort()),
    selectedSheets: [...selectedSheets].sort(),
  })
}

export function ProspectImportWorkbench() {
  const client = useTRPCClient()
  const [file, setFile] = useState<File | null>(null)
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null)
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [sheets, setSheets] = useState<SheetMeta[]>([])
  const [selectedSheets, setSelectedSheets] = useState<string[]>([])
  const [mapping, setMapping] = useState<Mapping>(initialMapping)
  const [detail, setDetail] = useState<ImportDetail | null>(null)
  const [history, setHistory] = useState<ImportHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('Choose a CSV or XLSX file to begin.')
  const [error, setError] = useState<string | null>(null)
  const pollingController = useRef<AbortController | null>(null)
  const historyController = useRef<AbortController | null>(null)

  const columns = useMemo(() => {
    const values = new Set<string>()
    for (const sheet of sheets.filter((item) => selectedSheets.includes(item.name)))
      for (const column of sheet.columns) values.add(column)
    return [...values].sort()
  }, [selectedSheets, sheets])

  const preview = useMemo(() => {
    if (!workbook || !selectedSheets[0]) return []
    const sheet = workbook.Sheets[selectedSheets[0]]
    if (!sheet) return []
    return XLSX.utils
      .sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
        raw: false,
        dateNF: 'yyyy-mm-dd',
      })
      .slice(0, 8)
      .map((row) => mappedRow(row, mapping, selectedSheets[0]!))
  }, [mapping, selectedSheets, workbook])

  const loadHistory = useCallback(async () => {
    historyController.current?.abort()
    const controller = new AbortController()
    historyController.current = controller
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const items = await runProspectImportRequest(controller.signal, (signal) =>
        client.admin.listProspectImports.query(undefined, { signal }),
      )
      throwIfProspectImportPollingCancelled(controller.signal)
      setHistory(items)
    } catch {
      if (!controller.signal.aborted) {
        setHistoryError(
          'Import history could not be loaded in time. Retry before assuming no retained imports exist.',
        )
      }
    } finally {
      if (historyController.current === controller) historyController.current = null
      if (!controller.signal.aborted) setHistoryLoading(false)
    }
  }, [client])

  useEffect(() => {
    void loadHistory()
    return () => {
      historyController.current?.abort()
      historyController.current = null
    }
  }, [loadHistory])

  useEffect(
    () => () => {
      pollingController.current?.abort()
      historyController.current?.abort()
    },
    [],
  )

  function beginPollingOperation() {
    pollingController.current?.abort()
    const controller = new AbortController()
    pollingController.current = controller
    return controller
  }

  function finishPollingOperation(controller: AbortController) {
    if (pollingController.current === controller) pollingController.current = null
  }

  async function refreshHistory(signal: AbortSignal) {
    const items = await runProspectImportRequest(signal, (requestSignal) =>
      client.admin.listProspectImports.query(undefined, { signal: requestSignal }),
    )
    throwIfProspectImportPollingCancelled(signal)
    setHistory(items)
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null
    setError(null)
    setDetail(null)
    if (!selected) return
    const extension = selected.name.split('.').pop()?.toLowerCase()
    if (extension !== 'csv' && extension !== 'xlsx') {
      setError('Only CSV and XLSX files are supported.')
      return
    }
    if (selected.size > 25 * 1024 * 1024) {
      setError('Spreadsheet exceeds the 25 MB safety limit.')
      return
    }
    setBusy(true)
    setProgress('Reading workbook locally…')
    try {
      const data = await selected.arrayBuffer()
      if (extension === 'xlsx') inspectXlsxArchive(data)
      const parsed = XLSX.read(data, { cellDates: true, dense: true })
      const metadata = parsed.SheetNames.slice(0, 100).map((name, index) => {
        const sheet = parsed.Sheets[name]
        const rows = sheet
          ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
              header: 1,
              blankrows: false,
              raw: false,
              dateNF: 'yyyy-mm-dd',
            })
          : []
        const header = (rows[0] ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)
        return { name, index, rows: Math.max(rows.length - 1, 0), columns: header }
      })
      const likelyDataSheets = metadata.filter((sheet) => sheet.columns.includes('venue_name'))
      setFile(selected)
      setBuffer(data)
      setWorkbook(parsed)
      setSheets(metadata)
      setSelectedSheets(
        (likelyDataSheets.length ? likelyDataSheets : metadata.filter((sheet) => sheet.rows)).map(
          (sheet) => sheet.name,
        ),
      )
      setProgress(`Detected ${metadata.length} sheets. Confirm selection and mapping.`)
    } catch (cause) {
      setError(
        cause instanceof XlsxArchivePreflightError && cause.code === 'EXPANDED_TOO_LARGE'
          ? 'The XLSX workbook expands beyond the 150 MB safety limit.'
          : cause instanceof XlsxArchivePreflightError && cause.code === 'TOO_MANY_ENTRIES'
            ? 'The XLSX workbook contains too many archived parts to inspect safely.'
            : 'The spreadsheet is malformed, encrypted, or could not be parsed safely.',
      )
      setProgress('File parsing failed.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshImport(importId: string, signal: AbortSignal) {
    const summary = await runProspectImportRequest(signal, (requestSignal) =>
      client.admin.getProspectImport.query({ importId, rowLimit: 1 }, { signal: requestSignal }),
    )
    const result = summary.prospectImport.duplicateRows
      ? await runProspectImportRequest(signal, (requestSignal) =>
          client.admin.getProspectImport.query(
            {
              importId,
              rowStatus: 'DUPLICATE_REVIEW',
              rowLimit: 200,
            },
            { signal: requestSignal },
          ),
        )
      : summary
    throwIfProspectImportPollingCancelled(signal)
    setDetail(result as ImportDetail)
    return result as ImportDetail
  }

  async function resolveDuplicateRow(
    rowId: string,
    decision: 'CREATE_DISTINCT' | 'LINK_EXISTING' | 'UPDATE_EXISTING' | 'SKIP' | 'QUARANTINE',
    targetOrganizationId?: string,
  ) {
    if (!detail) return
    const note = window.prompt(
      decision === 'CREATE_DISTINCT'
        ? 'Record the evidence that this row represents a distinct prospect.'
        : `Record the evidence for the ${decision.toLowerCase().replaceAll('_', ' ')} decision.`,
    )
    if (!note?.trim()) return
    const controller = beginPollingOperation()
    const { signal } = controller
    setBusy(true)
    setError(null)
    try {
      await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.resolveProspectImportRow.mutate(
          {
            importId: detail.prospectImport.id,
            rowId,
            decision,
            note: note.trim(),
            ...(targetOrganizationId ? { targetOrganizationId } : {}),
          },
          { signal: requestSignal },
        ),
      )
      const result = await refreshImport(detail.prospectImport.id, signal)
      setProgress(
        result.prospectImport.duplicateRows
          ? `${result.prospectImport.duplicateRows.toLocaleString()} possible duplicate rows remain.`
          : 'Duplicate review complete. The import is ready for approval.',
      )
    } catch {
      if (!signal.aborted) {
        setError(
          'The duplicate decision could not be confirmed. Reopen the import before retrying; the decision may already be saved.',
        )
      }
    } finally {
      if (!signal.aborted) setBusy(false)
      finishPollingOperation(controller)
    }
  }

  async function runDryRun() {
    if (!file || !buffer || !workbook || !selectedSheets.length || !mapping.venueName) return
    const controller = beginPollingOperation()
    const { signal } = controller
    setBusy(true)
    setError(null)
    try {
      setProgress('Hashing file and mapping for replay safety…')
      const [fileHash, mappingHash] = await Promise.all([
        sha256(buffer),
        sha256(stableMapping(mapping, selectedSheets)),
      ])
      const reserved = await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.reserveProspectImportUpload.mutate(
          {
            fileName: file.name,
            fileType: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx',
            fileSize: file.size,
            fileHash,
          },
          { signal: requestSignal },
        ),
      )
      throwIfProspectImportPollingCancelled(signal)
      const importId = reserved.importId
      setProgress('Uploading the immutable source workbook…')
      await uploadProspectWorkbook({
        url: reserved.url,
        requiredHeaders: reserved.requiredHeaders,
        file,
        signal,
      })
      throwIfProspectImportPollingCancelled(signal)
      await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.completeProspectImportUpload.mutate({ importId }, { signal: requestSignal }),
      )
      throwIfProspectImportPollingCancelled(signal)
      setProgress('The durable worker is inspecting workbook structure and safety limits…')
      let result = await refreshImport(importId, signal)
      for (
        let poll = 0;
        poll < 150 && result.prospectImport.progressCursor !== 'INSPECTED';
        poll += 1
      ) {
        await waitForProspectImportPoll(signal)
        result = await refreshImport(importId, signal)
      }
      if (result.prospectImport.progressCursor !== 'INSPECTED') {
        throw new Error(
          'Workbook inspection continues in the background; reopen this import shortly',
        )
      }
      await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.configureProspectImportMapping.mutate(
          {
            importId,
            mappingHash,
            mapping,
            selectedSheets,
          },
          { signal: requestSignal },
        ),
      )
      throwIfProspectImportPollingCancelled(signal)
      setProgress('The durable worker is staging and checking duplicate candidates…')
      for (let poll = 0; poll < 300; poll += 1) {
        await waitForProspectImportPoll(signal)
        result = await refreshImport(importId, signal)
        if (result.prospectImport.status === 'DRY_RUN_READY') break
      }
      if (result.prospectImport.status !== 'DRY_RUN_READY') {
        throw new Error('Dry-run staging continues in the background; reopen this import shortly')
      }
      await refreshHistory(signal)
      throwIfProspectImportPollingCancelled(signal)
      setProgress(
        `Dry run ready: ${result.prospectImport.totalRows.toLocaleString()} rows reviewed.`,
      )
    } catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Dry run failed.')
        setProgress('Dry run stopped safely. No prospects were imported.')
      }
    } finally {
      if (!signal.aborted) setBusy(false)
      finishPollingOperation(controller)
    }
  }

  async function approveAndImport() {
    if (!detail) return
    const controller = beginPollingOperation()
    const { signal } = controller
    setBusy(true)
    setError(null)
    try {
      await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.approveProspectImport.mutate(
          { importId: detail.prospectImport.id },
          { signal: requestSignal },
        ),
      )
      throwIfProspectImportPollingCancelled(signal)
      setProgress('Approved. The durable import worker is processing rows in the background…')
      let result = await refreshImport(detail.prospectImport.id, signal)
      for (let poll = 0; poll < 300; poll += 1) {
        if (['COMPLETE', 'PARTIAL', 'CANCELLED'].includes(result.prospectImport.status)) break
        await waitForProspectImportPoll(signal)
        result = await refreshImport(detail.prospectImport.id, signal)
        setProgress(
          `Worker import ${result.prospectImport.status.toLowerCase()}: ${result.prospectImport.importedRows.toLocaleString()} complete`,
        )
      }
      if (!['COMPLETE', 'PARTIAL', 'CANCELLED'].includes(result.prospectImport.status)) {
        setProgress(
          'Import continues in the background. Closing this page will not stop the durable job.',
        )
      }
      await refreshHistory(signal)
      throwIfProspectImportPollingCancelled(signal)
      setProgress(
        `Import ${result.prospectImport.status.toLowerCase()}: ${result.prospectImport.importedRows.toLocaleString()} rows imported.`,
      )
    } catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Import stopped.')
        setProgress(
          'Import paused safely. Retry uses the same row identities and will not duplicate completed rows.',
        )
        await refreshImport(detail.prospectImport.id, signal).catch(() => undefined)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
      finishPollingOperation(controller)
    }
  }

  async function cancelImport() {
    if (!detail) return
    const reason = window.prompt(
      'Record why this import should be cancelled. Imported rows are retained.',
    )
    if (!reason?.trim()) return
    const controller = beginPollingOperation()
    const { signal } = controller
    setBusy(true)
    setError(null)
    try {
      await runProspectImportRequest(signal, (requestSignal) =>
        client.admin.cancelProspectImport.mutate(
          {
            importId: detail.prospectImport.id,
            reason: reason.trim(),
          },
          { signal: requestSignal },
        ),
      )
      await refreshImport(detail.prospectImport.id, signal)
      await refreshHistory(signal)
      setProgress(
        'Import cancelled. Completed rows and provenance were retained; pending rows were skipped.',
      )
    } catch {
      if (!signal.aborted) {
        setError(
          'Import cancellation could not be confirmed. Reopen the import before retrying; cancellation may already be recorded.',
        )
      }
    } finally {
      if (!signal.aborted) setBusy(false)
      finishPollingOperation(controller)
    }
  }

  async function openImport(importId: string) {
    const controller = beginPollingOperation()
    const { signal } = controller
    setBusy(true)
    setError(null)
    try {
      await refreshImport(importId, signal)
    } catch {
      if (!signal.aborted) {
        setError('The retained import could not be loaded in time. Retry from import history.')
      }
    } finally {
      if (!signal.aborted) setBusy(false)
      finishPollingOperation(controller)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
            Controlled migration
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            Spreadsheet import workbench
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Torchiko persists hashes, mappings, source rows, warnings, and provenance, then a
            durable worker owns immutable source parsing, staging, duplicate review, and commit.
            Closing this page does not stop the job, and approval remains a separate human gate.
          </p>
        </div>
        <Link href="/admin/prospects" className="text-sm font-semibold text-sky-700">
          Back to directory
        </Link>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 text-center transition hover:border-sky-400 hover:bg-sky-50/40">
          <FileSpreadsheet className="h-8 w-8 text-sky-600" aria-hidden="true" />
          <span className="mt-3 font-semibold text-slate-900">
            {file ? file.name : 'Choose CSV or XLSX'}
          </span>
          <span className="mt-1 text-xs text-slate-500">
            Up to 25 MB · 100 sheets · 100,000 rows per sheet
          </span>
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void chooseFile(event)}
            className="sr-only"
          />
        </label>
        <div className="mt-4 flex items-center gap-2 text-sm text-slate-600" role="status">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-sky-600" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          )}{' '}
          {progress}
        </div>
        {error ? (
          <p
            className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>

      {workbook ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">1. Select sheets</h2>
            <p className="mt-1 text-sm text-slate-500">
              Summary and helper sheets are excluded automatically when they do not contain a
              venue_name column.
            </p>
            <div className="mt-4 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {sheets.map((sheet) => (
                <label
                  key={sheet.name}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedSheets.includes(sheet.name)}
                    onChange={(event) =>
                      setSelectedSheets((current) =>
                        event.target.checked
                          ? [...current, sheet.name]
                          : current.filter((name) => name !== sheet.name),
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                    {sheet.name}
                  </span>
                  <span className="text-xs text-slate-400">{sheet.rows.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">2. Confirm column mapping</h2>
            <p className="mt-1 text-sm text-slate-500">
              Venue name is required. Empty optional mappings stay empty; no personal facts are
              invented.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {FIELD_DEFINITIONS.map(([key, fieldLabel, required]) => (
                <label key={key} className="text-xs font-semibold text-slate-600">
                  {fieldLabel}
                  {required ? ' *' : ''}
                  <select
                    value={mapping[key]}
                    onChange={(event) =>
                      setMapping((current) => ({ ...current, [key]: event.target.value }))
                    }
                    className="mt-1 min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm font-normal text-slate-900"
                  >
                    <option value="">Not mapped</option>
                    {columns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold text-slate-950">3. Normalized preview</h2>
              <p className="mt-1 text-sm text-slate-500">
                Representative rows from {selectedSheets[0] ?? 'the selected sheet'}.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">Prospect import preview</caption>
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">
                      Venue
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Organization
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Location
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Website
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Contact
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.map((row, index) => (
                    <tr key={`${row.venueName}:${index}`}>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {row.venueName || <span className="text-rose-700">Missing</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {row.organizationName ?? row.venueName}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {[row.city, row.region].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td className="max-w-64 truncate px-4 py-3 text-slate-600">
                        {row.website ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {row.contactEmail ?? row.generalEmail ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-200 p-4">
              <button
                type="button"
                disabled={busy || !selectedSheets.length || !mapping.venueName}
                onClick={() => void runDryRun()}
                className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run dry run
              </button>
            </div>
          </section>
        </>
      ) : null}

      {detail ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <h2 className="font-semibold text-slate-950">Dry-run summary</h2>
              <p className="mt-1 text-xs font-medium uppercase tracking-wider text-slate-500">
                {detail.prospectImport.status}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.prospectImport.status === 'DRY_RUN_READY' ? (
                <button
                  type="button"
                  disabled={
                    busy ||
                    detail.prospectImport.duplicateRows > 0 ||
                    detail.prospectImport.validRows + detail.prospectImport.warningRows === 0
                  }
                  onClick={() => void approveAndImport()}
                  className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Approve reviewed rows and import
                </button>
              ) : null}
              {!['COMPLETE', 'CANCELLED'].includes(detail.prospectImport.status) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void cancelImport()}
                  className="rounded-xl border border-rose-300 bg-white px-4 py-2.5 text-sm font-semibold text-rose-800 disabled:opacity-50"
                >
                  Cancel import
                </button>
              ) : null}
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ['Total', detail.prospectImport.totalRows, 'slate'],
              ['Valid', detail.prospectImport.validRows, 'emerald'],
              ['Warnings', detail.prospectImport.warningRows, 'amber'],
              ['Duplicate review', detail.prospectImport.duplicateRows, 'rose'],
              ['Failed', detail.prospectImport.failedRows, 'rose'],
            ].map(([name, value]) => (
              <div key={String(name)} className="rounded-xl bg-slate-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{name}</p>
                <p className="mt-1 text-2xl font-bold text-slate-950">
                  {Number(value).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
          {detail.prospectImport.reportHash ? (
            <a
              href={`/api/admin/prospect-imports/${encodeURIComponent(detail.prospectImport.id)}/report`}
              className="mt-4 inline-flex rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-900"
            >
              Download immutable dry-run report
            </a>
          ) : null}
          {detail.prospectImport.duplicateRows ? (
            <div className="mt-4 space-y-3">
              <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <p>
                  {detail.prospectImport.duplicateRows.toLocaleString()} rows are held. Review each
                  visible row; approval remains disabled until every candidate is marked distinct or
                  skipped.
                </p>
              </div>
              {detail.rows.map((row) => {
                const values =
                  row.normalizedValues && typeof row.normalizedValues === 'object'
                    ? (row.normalizedValues as Record<string, unknown>)
                    : {}
                const matches = Array.isArray(row.duplicateMatches)
                  ? (row.duplicateMatches as Array<Record<string, unknown>>)
                  : []
                const bestOrganizationId =
                  typeof matches[0]?.organizationId === 'string'
                    ? matches[0].organizationId
                    : undefined
                return (
                  <article key={row.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
                      <div>
                        <p className="font-semibold text-slate-950">
                          {String(values.venueName ?? `Row ${row.originalRowNumber}`)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {row.sheetName}, row {row.originalRowNumber} ·{' '}
                          {matches
                            .map(
                              (match) =>
                                `${String(match.canonicalName ?? 'candidate')} (${Math.round(Number(match.confidence ?? 0) * 100)}%)`,
                            )
                            .join('; ') || 'Candidate evidence retained'}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || !bestOrganizationId}
                          onClick={() =>
                            void resolveDuplicateRow(row.id, 'LINK_EXISTING', bestOrganizationId)
                          }
                          className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900 disabled:opacity-50"
                        >
                          Link existing
                        </button>
                        <button
                          type="button"
                          disabled={busy || !bestOrganizationId}
                          onClick={() =>
                            void resolveDuplicateRow(row.id, 'UPDATE_EXISTING', bestOrganizationId)
                          }
                          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50"
                        >
                          Apply reviewed fields
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void resolveDuplicateRow(row.id, 'CREATE_DISTINCT')}
                          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900"
                        >
                          Import as distinct
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void resolveDuplicateRow(row.id, 'SKIP')}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700"
                        >
                          Skip row
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void resolveDuplicateRow(row.id, 'QUARANTINE')}
                          className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900"
                        >
                          Quarantine
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
              {detail.prospectImport.duplicateRows > detail.rows.length ? (
                <p className="text-xs text-slate-500">
                  Showing the first {detail.rows.length.toLocaleString()} candidates. Resolve these
                  to load the next group.
                </p>
              ) : null}
            </div>
          ) : null}
          {detail.prospectImport.status === 'COMPLETE' ||
          detail.prospectImport.status === 'PARTIAL' ? (
            <div className="mt-4 flex gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <p>
                {detail.prospectImport.importedRows.toLocaleString()} rows imported with durable
                source provenance. Re-running the same file and mapping reuses this import identity.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="font-semibold text-slate-950">Import history</h2>
          <p className="mt-1 text-sm text-slate-500">
            Retained mappings, hashes, row results, and approvals make retries and repairs
            traceable.
          </p>
        </div>
        {historyLoading ? (
          <p className="p-8 text-center text-sm text-slate-500" role="status">
            Loading retained imports…
          </p>
        ) : historyError ? (
          <div className="flex flex-col gap-3 p-6 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between">
            <p role="alert">{historyError}</p>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="min-h-11 rounded-xl border border-rose-300 bg-white px-4 font-semibold"
            >
              Retry history
            </button>
          </div>
        ) : history.length ? (
          <ul className="divide-y divide-slate-100">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void openImport(item.id)}
                  className="grid w-full gap-2 px-5 py-4 text-left hover:bg-sky-50/40 sm:grid-cols-[minmax(0,1fr)_9rem_10rem]"
                >
                  <span className="truncate font-semibold text-slate-900">{item.fileName}</span>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    {item.status}
                  </span>
                  <span className="text-xs text-slate-500">
                    {item.importedRows.toLocaleString()} / {item.totalRows.toLocaleString()}{' '}
                    imported
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-8 text-center text-sm text-slate-500">No retained imports yet.</p>
        )}
      </section>
    </div>
  )
}
