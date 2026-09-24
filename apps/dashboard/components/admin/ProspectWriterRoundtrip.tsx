'use client'
import { useEffect, useId, useRef, useState } from 'react'
import {
  nativeWriterResult,
  type NativeWriterResult,
  type NativeWriterTask,
} from '@pathfinder/api/prospect-writer-contract'
import type { NativeSalesAction, SalesWorkflowView } from '@pathfinder/api/prospect-sales-contract'

const button =
  'min-h-11 rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:opacity-50'
export function ProspectWriterRoundtrip({
  view,
  enabled,
  exportTask,
  onAction,
}: {
  view: SalesWorkflowView
  enabled: boolean
  exportTask: () => Promise<NativeWriterTask>
  onAction: (action: NativeSalesAction) => Promise<boolean | void>
}) {
  const id = useId()
  const [result, setResult] = useState<NativeWriterResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const operation = useRef(0)
  const importInFlight = useRef(false)
  const venue = useRef(view.venueId)
  venue.current = view.venueId
  useEffect(() => {
    operation.current++
    importInFlight.current = false
    setResult(null)
    setError(null)
    setNotice(null)
    setBusy(false)
    return () => {
      operation.current++
    }
  }, [view.venueId])
  async function download() {
    if (busy || !enabled) return
    const sequence = ++operation.current
    const venueId = view.venueId
    setBusy(true)
    setError(null)
    try {
      const task = await exportTask()
      if (sequence !== operation.current || venue.current !== venueId) return
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `${task.taskId}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      if (sequence === operation.current)
        setError(reason instanceof Error ? reason.message : 'Writer task unavailable')
    } finally {
      if (sequence === operation.current) setBusy(false)
    }
  }
  async function readResult(file?: File) {
    const sequence = ++operation.current
    const venueId = view.venueId
    setResult(null)
    setError(null)
    setNotice(null)
    if (!file) return
    setBusy(true)
    try {
      if (file.size > 60_000)
        throw new Error(
          'Use one JSON result file, at most 60,000 bytes. Archives and fetched paths are not supported.',
        )
      const parsed = nativeWriterResult.parse(JSON.parse(await file.text()))
      if (sequence !== operation.current || venue.current !== venueId) return
      if (parsed.binding.venueId !== venueId)
        throw new Error('This result belongs to a different prospect.')
      setResult(parsed)
    } catch (reason) {
      if (sequence === operation.current)
        setError(reason instanceof Error ? reason.message : 'Invalid writer result')
    } finally {
      if (sequence === operation.current) setBusy(false)
    }
  }
  async function importResult() {
    if (
      !result ||
      importInFlight.current ||
      busy ||
      !enabled ||
      result.binding.venueId !== view.venueId
    )
      return
    importInFlight.current = true
    const sequence = ++operation.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const confirmed = await onAction({
        action: 'importWriterResult',
        input: {
          venueId: result.binding.venueId,
          expectedSnapshotHash: result.binding.nativeSnapshotHash,
          result,
        },
      })
      if (confirmed === true && sequence === operation.current) {
        setResult(null)
        setNotice(
          'Exact result receipt confirmed. Review the saved draft and its attribution below; no approval or send occurred.',
        )
      } else if (sequence === operation.current) {
        setNotice(
          'Receipt not confirmed. This exact candidate is still retained here. Keep this exact result file and retry the same candidate after the connection or access hold is resolved; do not generate a replacement. No approval or send occurred.',
        )
      }
    } catch (reason) {
      if (sequence === operation.current) {
        setError(reason instanceof Error ? reason.message : 'Import response unavailable')
        setNotice(
          'Keep this exact result file. If the response was lost, retry the same file to recover its receipt. A retry does not approve or send it.',
        )
      }
    } finally {
      if (sequence === operation.current) {
        importInFlight.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section
      aria-label="AI writer roundtrip"
      className="mt-6 min-w-0 border-t border-slate-300 pt-5"
    >
      <h3 className="font-bold text-slate-950">Write from this exact context</h3>
      <p className="mt-2 text-sm leading-6 text-slate-700">
        Export the current preparation to a foreground AI writer, then import its result. Source
        references and assessments return with the text; you do not have to reconstruct them by
        hand.
      </p>
      <p className="mt-2 text-xs leading-5 font-semibold text-slate-700">
        INTERNAL WRITER CONTEXT · NOT AN EMAIL BODY · NO APPROVAL OR SEND
      </p>
      {view.writerHold ? (
        <p className="mt-3 text-sm leading-6 text-amber-950">{view.writerHold}</p>
      ) : null}
      <button
        type="button"
        className={`${button} mt-3`}
        disabled={!enabled || busy || !view.writerTask}
        onClick={() => void download()}
      >
        Download current writer task
      </button>
      <label htmlFor={id} className="mt-5 block text-sm font-semibold text-slate-900">
        AI result JSON file
      </label>
      <input
        id={id}
        type="file"
        accept="application/json,.json"
        disabled={!enabled || busy}
        className="mt-2 block min-h-11 w-full min-w-0 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          // Permit selecting the same exact file again after its receipt is confirmed.
          e.currentTarget.value = ''
          void readResult(file)
        }}
      />
      {busy ? (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Working with this exact writer result…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-slate-700">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-3 border-l-4 border-rose-700 bg-rose-50 p-3 text-sm whitespace-pre-wrap"
        >
          {error}
        </p>
      ) : null}
      {result && result.binding.venueId === view.venueId ? (
        <div className="mt-4 border-l-2 border-slate-300 pl-4 text-sm leading-6">
          <p>
            <strong>Generated by model:</strong> {result.generatedBy.identity}
          </p>
          <p>
            <strong>Assessed by model:</strong>{' '}
            {result.assessment?.reviewer.identity ??
              'Not supplied — meaning review will remain required'}
          </p>
          <p className="mt-2 break-words font-semibold">{result.subject}</p>
          <p className="mt-2 break-words whitespace-pre-wrap">{result.body}</p>
          <p className="mt-2 break-all text-xs">
            Bound recipient:{' '}
            {result.binding.recipient ?? 'Unavailable — no recipient has been inferred'}
          </p>
          <p className="mt-2 text-xs">
            Importing records the submitting operator separately. No Tom authorship, authenticated
            human review, read acknowledgment or approval is inferred.
          </p>
          <button
            type="button"
            className={`${button} mt-3`}
            disabled={!enabled || busy}
            onClick={() => void importResult()}
          >
            Import exact AI candidate
          </button>
        </div>
      ) : null}
      {view.draft?.writerAttribution ? (
        <dl className="mt-4 border-t border-slate-200 pt-3 text-xs leading-5">
          <dt className="font-semibold">Saved generation attribution</dt>
          <dd>Model · {view.draft.writerAttribution.generatedBy}</dd>
          <dt className="mt-2 font-semibold">Submitted by (not the author)</dt>
          <dd>{view.draft.writerAttribution.submittedBy}</dd>
          <dt className="mt-2 font-semibold">Exact task / result</dt>
          <dd className="break-all">
            {view.draft.writerAttribution.taskId}
            <br />
            {view.draft.writerAttribution.resultHash}
          </dd>
        </dl>
      ) : null}
      {view.writerImportReceipt ? (
        <p className="mt-3 text-xs leading-5 text-slate-700">
          Exact import receipt {view.writerImportReceipt.id} · draft{' '}
          {view.writerImportReceipt.draftId}.
          {view.writerImportReceipt.replayed
            ? ' This result was already stored; no new draft, assessment or approval was created.'
            : ' Imported for review; no send approval was created.'}
          {view.draft?.id !== view.writerImportReceipt.draftId
            ? ' A newer draft is now current; inspect the retained revision history.'
            : ''}
        </p>
      ) : null}
    </section>
  )
}
