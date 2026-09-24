'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, BookOpenCheck, CircleCheck, RefreshCw } from 'lucide-react'

import {
  createProspectPreparationWorkspace,
  type PreparationWorkspaceItem,
  type PreparationWorkspaceSnapshot,
  type PreparationWorkspaceTransport,
} from '../../lib/prospect-preparation-workspace'

type SavedWritingGuide = {
  id: 'torchiko-v0.2'
  label: string
  sourceRef: string
  state: 'available' | 'unavailable' | 'unconfigured'
  sha256: string | null
}

const button =
  'min-h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:opacity-50'

function statusLabel(status: PreparationWorkspaceItem['status']) {
  return status.toLowerCase().replaceAll('_', ' ')
}

function statusClass(status: PreparationWorkspaceItem['status']) {
  if (status === 'PREPARED' || status === 'RESULT_RETAINED')
    return 'bg-emerald-100 text-emerald-900'
  if (status === 'READABLE') return 'bg-sky-100 text-sky-900'
  if (status === 'LOADING') return 'bg-slate-100 text-slate-700'
  return 'bg-amber-100 text-amber-950'
}

function resolveAction(item: PreparationWorkspaceItem) {
  switch (item.status) {
    case 'AMBIGUOUS_VENUE':
      return 'Choose one venue'
    case 'AMBIGUOUS_THREAD':
      return 'Choose one thread'
    case 'PREPARED':
      return 'Open the source-bound task'
    case 'RESULT_RETAINED':
      return 'Inspect the retained review draft'
    case 'PREPARE_UNCERTAIN':
    case 'IMPORT_UNCERTAIN':
      return 'Reload the native record before retrying'
    case 'MISSING_ROUTE':
    case 'SUPPRESSED':
      return 'Use the native record to resolve this hold'
    default:
      return 'Inspect the current record'
  }
}

export function ProspectPreparationWorkspace({
  organizationIds,
  transport,
  savedWritingGuide,
  directoryHref = '/admin/prospects',
  reopenSession = false,
}: {
  organizationIds: readonly string[]
  transport: PreparationWorkspaceTransport
  /** This descriptor is supplied by the authenticated readiness owner. It carries no guide text. */
  savedWritingGuide?: SavedWritingGuide | null
  directoryHref?: string
  /** Explicitly restore the compact refs-only session state; it never restores message body text. */
  reopenSession?: boolean
}) {
  const workspace = useMemo(() => createProspectPreparationWorkspace({ transport }), [transport])
  const [snapshot, setSnapshot] = useState<PreparationWorkspaceSnapshot>(() => workspace.snapshot())
  const [error, setError] = useState<string | null>(null)
  const appliedSelection = useRef<{
    workspace: typeof workspace
    key: string
    reopen: boolean
  } | null>(null)
  const selectionKey = organizationIds.join('\u0001')

  useEffect(() => workspace.subscribe(() => setSnapshot(workspace.snapshot())), [workspace])

  useEffect(() => {
    if (
      appliedSelection.current?.workspace === workspace &&
      appliedSelection.current.key === selectionKey &&
      appliedSelection.current.reopen === reopenSession
    )
      return
    appliedSelection.current = { workspace, key: selectionKey, reopen: reopenSession }
    setSnapshot(workspace.snapshot())
    setError(null)
    void (
      reopenSession ? workspace.reopen() : workspace.selectOrganizations(organizationIds)
    ).catch((reason) => {
      setError(
        reason instanceof Error ? reason.message : 'The selected records could not be opened',
      )
    })
  }, [organizationIds, reopenSession, selectionKey, workspace])

  async function perform(action: () => Promise<unknown> | unknown) {
    setError(null)
    try {
      await action()
      setSnapshot(workspace.snapshot())
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The requested preparation action could not finish',
      )
      setSnapshot(workspace.snapshot())
    }
  }

  return (
    <section
      className="border-y border-slate-300 bg-slate-50 px-4 py-5 sm:px-5"
      aria-labelledby="preparation-workspace-title"
    >
      <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-slate-700">
            <BookOpenCheck className="h-5 w-5" aria-hidden="true" />
            <h2 id="preparation-workspace-title" className="text-base font-bold text-slate-950">
              Selected-record preparation
            </h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Choose the venue and saved guide for each selected organization, then prepare its
            current sources for writing. Progress is retained separately for each record.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs font-semibold text-slate-700">
          <span className="rounded-full bg-white px-3 py-1.5 ring-1 ring-slate-200">
            {snapshot.items.length}/10 selected
          </span>
          <span className="rounded-full bg-white px-3 py-1.5 ring-1 ring-slate-200">
            {snapshot.counts.PREPARED + snapshot.counts.RESULT_RETAINED} retained
          </span>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 border-l-4 border-amber-700 bg-amber-50 px-4 py-3 text-sm text-amber-950"
        >
          {error}
        </div>
      ) : null}
      {!snapshot.storageAvailable ? (
        <p className="mt-4 text-sm text-amber-950" role="status">
          Session recovery storage is unavailable. Native records and receipts remain authoritative,
          but reopening this browser workspace will require selecting the records again.
        </p>
      ) : null}

      <ul className="mt-5 divide-y divide-slate-200 border-y border-slate-200 bg-white">
        {snapshot.items.map((item) => {
          const prepared = item.status === 'PREPARED' || item.status === 'RESULT_RETAINED'
          const requiresAnswer = Boolean(
            item.view?.correspondence?.latestInbound || item.selectedThreadId,
          )
          const canPrepare =
            ['READABLE', 'STALE', 'PREPARE_UNCERTAIN'].includes(item.status) &&
            Boolean(item.guide) &&
            !requiresAnswer &&
            Boolean(item.view?.gate.canPrepare)
          const hasGuide = Boolean(item.guide)
          const availableGuide =
            savedWritingGuide?.state === 'available' && typeof savedWritingGuide.sha256 === 'string'
          return (
            <li key={item.organizationId} className="p-4 sm:p-5">
              <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words font-bold text-slate-950">
                      {item.organizationName ?? `Organization ${item.organizationId}`}
                    </h3>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${statusClass(item.status)}`}
                    >
                      {statusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    {item.reason ?? resolveAction(item)}
                  </p>
                </div>
                <Link
                  href={`${directoryHref}/${item.organizationId}`}
                  className="inline-flex min-h-10 shrink-0 items-center gap-2 self-start rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
                >
                  Open detailed review <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>

              {item.venueChoices.length > 1 ? (
                <label className="mt-4 block max-w-xl text-sm font-semibold text-slate-900">
                  Exact native venue
                  <select
                    aria-label={`Exact native venue for ${item.organizationName ?? item.organizationId}`}
                    value={item.venueId ?? ''}
                    onChange={(event) =>
                      void perform(() =>
                        workspace.chooseVenue(item.organizationId, event.target.value),
                      )
                    }
                    className="mt-2 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
                  >
                    <option value="">Choose one venue</option>
                    {item.venueChoices.map((venue) => (
                      <option key={venue.id} value={venue.id}>
                        {venue.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs font-normal leading-5 text-slate-600">
                    This organization has several venues. No venue is inferred from the directory
                    ID.
                  </span>
                </label>
              ) : item.venueId ? (
                <p className="mt-4 text-sm text-slate-700">
                  Native venue:{' '}
                  <span className="font-semibold">
                    {item.venueChoices[0]?.name ?? item.venueId}
                  </span>
                </p>
              ) : null}

              {item.view?.threadCandidates.length && item.view.threadCandidates.length > 1 ? (
                <label className="mt-4 block max-w-xl text-sm font-semibold text-slate-900">
                  Exact native thread
                  <select
                    aria-label={`Exact native thread for ${item.organizationName ?? item.organizationId}`}
                    value={item.selectedThreadId ?? ''}
                    onChange={(event) =>
                      void perform(() =>
                        workspace.chooseThread(item.organizationId, event.target.value),
                      )
                    }
                    className="mt-2 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
                  >
                    <option value="">Choose one retained thread</option>
                    {item.view.threadCandidates.map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {thread.id} · {thread.messageCount} messages ·{' '}
                        {thread.sourceComplete ? 'source available' : 'source incomplete'}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-700 sm:grid-cols-2 xl:grid-cols-4">
                <p>
                  <span className="font-semibold text-slate-900">Route:</span>{' '}
                  {item.view?.routing?.value ?? 'not selected'}
                </p>
                <p>
                  <span className="font-semibold text-slate-900">Contacts:</span>{' '}
                  {item.view?.contacts.length ?? 0} recorded
                </p>
                <p>
                  <span className="font-semibold text-slate-900">Sources:</span>{' '}
                  {item.view?.sourceCount ?? 0} in current view
                </p>
                <p className="break-all">
                  <span className="font-semibold text-slate-900">Snapshot:</span>{' '}
                  {item.view?.snapshotHash ?? 'unavailable'}
                </p>
              </div>

              <div className="mt-4 border-l-2 border-sky-700 bg-sky-50 px-4 py-3 text-sm text-slate-800">
                <p className="font-semibold">Saved Torchiko guide</p>
                {hasGuide ? (
                  <p className="mt-1 break-all text-xs leading-5">
                    Selected: {item.guide!.sourceRef} · SHA-256 {item.guide!.sha256}
                  </p>
                ) : availableGuide ? (
                  <p className="mt-1 text-xs leading-5">
                    Choose the saved guide to use for this record’s preparation.
                  </p>
                ) : (
                  <p className="mt-1 text-xs leading-5">
                    {savedWritingGuide
                      ? `Unavailable: ${savedWritingGuide.state}. ${savedWritingGuide.label} cannot be substituted with a local path or stale copy.`
                      : 'The authenticated guide descriptor is unavailable. This workspace keeps the record held rather than substituting a local path, stale copy, or unselected writing reference.'}
                  </p>
                )}
                {availableGuide && !hasGuide ? (
                  <button
                    type="button"
                    className={`${button} mt-3`}
                    onClick={() =>
                      void perform(() =>
                        workspace.setGuide(item.organizationId, {
                          sourceRef: savedWritingGuide!.sourceRef,
                          sha256: savedWritingGuide!.sha256!,
                        }),
                      )
                    }
                  >
                    Use saved Torchiko guide
                  </button>
                ) : null}
                {hasGuide ? (
                  <button
                    type="button"
                    className="mt-3 text-xs font-semibold text-sky-900 underline"
                    onClick={() =>
                      void perform(() => workspace.setGuide(item.organizationId, null))
                    }
                  >
                    Remove selected guide
                  </button>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={button}
                  onClick={() => void perform(() => workspace.refresh(item.organizationId))}
                >
                  <RefreshCw className="mr-2 inline h-4 w-4" aria-hidden="true" /> Reload native
                  state
                </button>
                {canPrepare ? (
                  <button
                    type="button"
                    className="min-h-10 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
                    onClick={() => void perform(() => workspace.prepare(item.organizationId))}
                  >
                    {item.status === 'PREPARE_UNCERTAIN'
                      ? 'Retry exact preparation'
                      : 'Prepare current record'}
                  </button>
                ) : null}
                {prepared ? (
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800">
                    <CircleCheck className="h-4 w-4" aria-hidden="true" /> Existing detailed review
                    remains the next step
                  </span>
                ) : null}
                {requiresAnswer ? (
                  <p className="text-sm text-slate-700">
                    Open detailed review to answer the selected inbound message before preparation.
                  </p>
                ) : null}
                {item.status === 'PREPARE_UNCERTAIN' || item.status === 'IMPORT_UNCERTAIN' ? (
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-amber-950">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Retry only after
                    read-back confirms the same source binding
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
