'use client'

import {
  ProspectLaunchAttachmentSelection,
  ProspectLaunchAttachmentList,
} from './ProspectLaunchAttachmentSelection'
import type { VenueLaunchAssetSelection } from '@pathfinder/contracts/venue-launch-asset'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ProspectEvidenceAdmission } from './ProspectEvidenceAdmission'
import type {
  NativeSalesAction,
  SalesActionResponse,
  SalesWorkflowView,
} from '@pathfinder/api/prospect-sales-contract'
import { useTRPCClient } from '../../lib/trpc'
import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { ProspectClaimMeaningReview } from './ProspectClaimMeaningReview'
import { ProspectWriterRoundtrip } from './ProspectWriterRoundtrip'
import { ProspectOperationalHandoff } from './ProspectOperationalHandoff'

type Transport = {
  load: (venueId: string) => Promise<SalesWorkflowView>
  act: (action: NativeSalesAction) => Promise<SalesActionResponse>
}
type SavedGuideDescriptor = {
  state: string
  sha256: string | null
}
type SalesReadiness = {
  component: { state: string; reason: string }
  writingGuide: SavedGuideDescriptor
  nextAction: string
}
type TemporaryEditorRecovery = {
  subject: string
  body: string
}
type RecoveryPrompt = { kind: 'reload' } | { kind: 'navigation'; href: string }

const TEMPORARY_EDITOR_RECOVERY_PREFIX = 'torchiko.prospect-sales-review.recovery.v1'

function temporaryRecoveryKey(venueId: string) {
  return `${TEMPORARY_EDITOR_RECOVERY_PREFIX}:${encodeURIComponent(venueId)}`
}

function temporaryRecoveryStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readTemporaryRecovery(venueId: string): TemporaryEditorRecovery | null {
  try {
    const value = JSON.parse(
      temporaryRecoveryStorage()?.getItem(temporaryRecoveryKey(venueId)) ?? 'null',
    ) as TemporaryEditorRecovery | null
    if (!value || typeof value.subject !== 'string' || typeof value.body !== 'string') return null
    if (value.subject.length > 160 || value.body.length > 12000) return null
    return value
  } catch {
    return null
  }
}

function writeTemporaryRecovery(venueId: string, value: TemporaryEditorRecovery): boolean {
  try {
    const storage = temporaryRecoveryStorage()
    if (!storage) return false
    storage.setItem(temporaryRecoveryKey(venueId), JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function clearTemporaryRecovery(venueId: string): void {
  try {
    temporaryRecoveryStorage()?.removeItem(temporaryRecoveryKey(venueId))
  } catch {
    // The editor and native CRM workflow remain usable when session storage is disabled.
  }
}

function responseScope(view: SalesWorkflowView | null, selectedThreadId: string): string | null {
  if (!view) return null
  return `${view.venueId}:${selectedThreadId || view.correspondence?.threadId || 'no-thread'}`
}

function currentViewFailureMessage(
  failure:
    | 'RECORD_NOT_FOUND'
    | 'STATE_CONFLICT'
    | 'ACCESS_OR_POLICY_HOLD'
    | 'READ_FAILED'
    | undefined,
): string {
  switch (failure) {
    case 'RECORD_NOT_FOUND':
      return 'The current CRM record was not found.'
    case 'STATE_CONFLICT':
      return 'The current CRM state changed or conflicts with this result.'
    case 'ACCESS_OR_POLICY_HOLD':
      return 'Current CRM state is held by access or policy.'
    default:
      return 'The current CRM state could not be read.'
  }
}

const button =
  'min-h-11 rounded-md border border-slate-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:cursor-not-allowed disabled:opacity-50'
const field =
  'mt-2 block min-h-11 w-full min-w-0 rounded-md border border-slate-400 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:bg-slate-100'
const label = (value: string) => value.replaceAll('_', ' ')
const readinessNextSteps: Record<string, string> = {
  CONFIGURE_PRIVATE_COMPONENT_OWNER: 'Configure the private writing components for this instance',
  INSTALL_PRIVATE_COMPONENT_OWNER: 'Restore the private writing components on this instance',
  RESTORE_EXACT_SAVED_WRITING_GUIDE: 'Restore the saved Torchiko guide',
  SELECT_VENUE_AND_PREPARE_EXPLICITLY: 'Choose the saved guide and prepare this venue',
}
const readinessNextStep = (value: string) =>
  readinessNextSteps[value] ?? 'Refresh writing readiness to check the available route'

async function localResponse(response: Response): Promise<SalesActionResponse> {
  const result = (await response.json()) as SalesActionResponse & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'Local sales preparation failed')
  if (result.SEND_AUTHORIZED !== false || result.senderAvailable !== false)
    throw new Error('Invalid NO-SEND review response')
  if (
    'schema' in result &&
    (result.schema !== 'torchiko.native-writer-import-receipt-only/1' ||
      !result.writerImportReceipt?.id ||
      !result.originalSnapshotHash)
  )
    throw new Error('Invalid immutable import receipt')
  return result
}
const localTransport: Transport = {
  load: (venueId) =>
    fetch(`/dev-fixtures/prospect-research/sales?venueId=${encodeURIComponent(venueId)}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async (response) => {
      const result = await localResponse(response)
      if ('schema' in result)
        throw new Error('The current CRM view is unavailable; reload before preparing')
      return result
    }),
  act: (action) =>
    fetch('/dev-fixtures/prospect-research/sales', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Torchiko-No-Send': '1' },
      body: JSON.stringify(action),
    }).then(localResponse),
}

export function ProspectSalesPreparation({
  venueId,
  mode,
}: {
  venueId: string
  mode: 'local' | 'admin'
}) {
  return mode === 'local' ? (
    <ProspectSalesReviewPanel venueId={venueId} transport={localTransport} local />
  ) : (
    <AdminSalesPreparation venueId={venueId} />
  )
}
function AdminSalesPreparation({ venueId }: { venueId: string }) {
  const client = useTRPCClient()
  const [readiness, setReadiness] = useState<SalesReadiness | null>(null)
  const [readinessError, setReadinessError] = useState(false)
  const [readinessRevision, setReadinessRevision] = useState(0)
  useEffect(() => {
    let active = true
    setReadiness(null)
    setReadinessError(false)
    runBoundedClientRequest({
      parentSignal: new AbortController().signal,
      timeoutMs: 15000,
      request: (signal) => client.admin.getProspectSalesReadiness.query(undefined, { signal }),
    })
      .then((value) => {
        if (active) setReadiness(value)
      })
      .catch(() => {
        if (active) setReadinessError(true)
      })
    return () => {
      active = false
    }
  }, [client, venueId, readinessRevision])
  const load = useCallback(
    (id: string) =>
      runBoundedClientRequest({
        parentSignal: new AbortController().signal,
        timeoutMs: 15000,
        request: (signal) =>
          client.admin.getProspectSalesWorkflow.query({ venueId: id }, { signal }),
      }),
    [client],
  )
  const act = useCallback(
    (action: NativeSalesAction) => client.admin.prepareReviewProspectSales.mutate(action),
    [client],
  )
  return (
    <>
      <div
        className="mb-4 rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-700"
        aria-label="Writing route readiness"
      >
        {readiness ? (
          <>
            <p>
              {readiness.component.state === 'paths-present-runtime-unverified'
                ? 'The private writing files are available. Preparation will verify they can run.'
                : 'The private writing route needs setup before preparation.'}
            </p>
            <p className="mt-1">{readinessNextStep(readiness.nextAction)}.</p>
          </>
        ) : (
          <p>
            {readinessError
              ? 'Writing readiness could not be checked in this authenticated session.'
              : 'Checking this instance’s writing route…'}
          </p>
        )}
        <button
          type="button"
          className={`${button} mt-2`}
          onClick={() => setReadinessRevision((value) => value + 1)}
        >
          Refresh writing readiness
        </button>
      </div>
      <ProspectSalesReviewPanel
        venueId={venueId}
        transport={{ load, act }}
        {...(readiness ? { savedGuide: readiness.writingGuide } : {})}
      />
    </>
  )
}

/** Same review surface for native admin authority and the explicitly opted-in loopback harness. */
export function ProspectSalesReviewPanel({
  venueId,
  transport,
  local = false,
  savedGuide,
}: {
  venueId: string
  transport: Transport
  local?: boolean
  savedGuide?: SavedGuideDescriptor
}) {
  const controlId = useId()
  const [launchAssetSelection, setLaunchAssetSelection] =
    useState<VenueLaunchAssetSelection | null>(null)
  const [view, setView] = useState<SalesWorkflowView | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [editorTouched, setEditorTouched] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState('')
  const [temporaryRecovery, setTemporaryRecovery] = useState<TemporaryEditorRecovery | null>(null)
  const [recoveryPrompt, setRecoveryPrompt] = useState<RecoveryPrompt | null>(null)
  const requestGeneration = useRef(0)
  const hydratedResponseScope = useRef<string | null>(null)
  const [answerScope, setAnswerScope] = useState<string | null>(null)
  const hydrate = useCallback((next: SalesWorkflowView, preserveEditor = false) => {
    setView(next)
    const selectedAsset = next.preparation?.launchAttachments?.[0]
    setLaunchAssetSelection(
      selectedAsset
        ? {
            tenantId: selectedAsset.tenantId,
            venueId: selectedAsset.venueId,
            release: selectedAsset.release,
            publicUrl: selectedAsset.publicUrl,
            sha256: selectedAsset.sha256,
          }
        : null,
    )
    const nextThreadId = next.correspondence?.threadId ?? ''
    setSelectedThreadId(nextThreadId)
    const nextResponseScope = responseScope(next, nextThreadId)
    if (hydratedResponseScope.current !== nextResponseScope) {
      setAnswerText('')
      setAnswerScope(null)
    }
    hydratedResponseScope.current = nextResponseScope
    if (preserveEditor) return
    setEditorTouched(false)
    if (next.draft && next.draft.state !== 'STALE') {
      setSubject(next.draft.subject)
      setBody(next.draft.body)
    } else {
      const inbound = next.correspondence?.latestInbound
      setSubject(
        inbound
          ? (inbound.subject.startsWith('Re:') ? inbound.subject : `Re: ${inbound.subject}`).slice(
              0,
              160,
            )
          : '',
      )
      setBody('')
    }
  }, [])
  useEffect(() => {
    let active = true
    const generation = ++requestGeneration.current
    setPending(true)
    setError(null)
    transport
      .load(venueId)
      .then((next) => {
        if (active && generation === requestGeneration.current) {
          hydrate(next)
          setTemporaryRecovery(readTemporaryRecovery(venueId))
        }
      })
      .catch((reason) => {
        if (active && generation === requestGeneration.current)
          setError(
            reason instanceof Error ? reason.message : 'The local workflow could not be loaded',
          )
      })
      .finally(() => {
        if (active && generation === requestGeneration.current) setPending(false)
      })
    return () => {
      active = false
    }
  }, [venueId, transport.load, hydrate])

  async function reload() {
    const generation = ++requestGeneration.current
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const next = await transport.load(venueId)
      if (generation === requestGeneration.current) hydrate(next)
    } catch (reason) {
      if (generation === requestGeneration.current)
        setError(reason instanceof Error ? reason.message : 'Could not reload the native workflow')
    } finally {
      if (generation === requestGeneration.current) setPending(false)
    }
  }
  async function performAction(value: NativeSalesAction): Promise<boolean> {
    if (pending || view?.venueId !== venueId) return false
    const generation = ++requestGeneration.current
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const next = await transport.act(value)
      if (generation !== requestGeneration.current) return false
      if (
        value.action === 'importWriterResult' &&
        (!next.writerImportReceipt?.id || !next.writerImportReceipt.draftId)
      )
        throw new Error('Import response did not include the immutable draft receipt.')
      if ('schema' in next) {
        setView(null)
        const currentViewFailure = currentViewFailureMessage(next.currentViewFailure)
        setMessage(
          next.writerImportReceipt.replayed
            ? `Exact AI result was already retained as ${next.writerImportReceipt.id}, draft ${next.writerImportReceipt.draftId}. ${currentViewFailure} Reload before further action. The retry created no new revision or approval.`
            : `AI result was saved as ${next.writerImportReceipt.id}, draft ${next.writerImportReceipt.draftId}. ${currentViewFailure} Reload before further action. No send approval was created.`,
        )
        return true
      }
      if (value.action === 'prepare') setView(next)
      else hydrate(next)
      if (value.action === 'save') {
        clearTemporaryRecovery(venueId)
        setTemporaryRecovery(null)
      }
      setMessage(
        value.action === 'prepare'
          ? 'Source-bound writing context prepared. No draft has been sent.'
          : value.action === 'save'
            ? 'An exact, immutable revision is now in native CRM review. SEND AUTHORIZED: NO.'
            : value.action === 'meaning'
              ? 'Claim and meaning findings are recorded for these exact bytes and sources. Read acknowledgment and all approvals remain separate.'
              : value.action === 'admitEvidence'
                ? 'Exact source selection recorded. The Research Gate was re-evaluated; prepare again before reviewing changed evidence. No approval or permission was granted.'
                : [
                      'handoffOperational',
                      'reviewOperational',
                      'stageOperational',
                      'approveOperationalBatch',
                      'releaseSyntheticBatch',
                    ].includes(value.action)
                  ? 'Separate operational-owner action recorded. Original NO-SEND source is unchanged. Synthetic fixtures are not Tom approval; check the exact candidate and delivery state below.'
                  : value.action === 'importWriterResult'
                    ? next.writerImportReceipt?.replayed
                      ? `Exact AI result was already imported as ${next.writerImportReceipt.id}. The current draft/review heads are shown below; no new revision or approval was created.`
                      : 'AI candidate imported with generation/submission attribution and exact annotations. Any assessment holds remain visible; no approval or read acknowledgment was created.'
                    : 'This exact revision is marked reviewed. It is not approved for sending.',
      )
      return true
    } catch (reason) {
      if (generation !== requestGeneration.current) return false
      const detail =
        reason instanceof Error
          ? reason.message
          : 'The local action failed; no delivery is available'
      setError(
        value.action === 'importWriterResult'
          ? `${detail} Keep the exact result file and retry it to recover a potentially committed receipt; do not generate a replacement just because the response failed.`
          : detail,
      )
      return false
    } finally {
      if (generation === requestGeneration.current) setPending(false)
    }
  }
  async function action(value: NativeSalesAction): Promise<void> {
    await performAction(value)
  }
  const held = view?.suppression.blocked ?? false
  const viewMatchesVenue = view?.venueId === venueId
  const prepared = view?.preparation
  const multipleThreads = (view?.threadCandidates?.length ?? 0) > 1
  const selectedCandidate =
    multipleThreads && view?.threadCandidates?.some((thread) => thread.id === selectedThreadId)
  const selectedCoverage = view?.threadCandidates?.find((thread) => thread.id === selectedThreadId)
  const currentResponseScope = responseScope(view, selectedThreadId)
  const needsAnswer = Boolean(view?.correspondence?.latestInbound || selectedCandidate)
  const canPrepare = Boolean(
    viewMatchesVenue &&
    (view?.gate.canPrepare || selectedCandidate) &&
    !pending &&
    !held &&
    (!multipleThreads || selectedCandidate) &&
    (!multipleThreads || selectedCoverage?.sourceComplete) &&
    (!needsAnswer || (answerScope === currentResponseScope && answerText.trim().length >= 12)),
  )
  const canSave = Boolean(
    viewMatchesVenue &&
    view?.gate.canPrepare &&
    prepared &&
    !prepared.stale &&
    !pending &&
    !held &&
    subject.trim() &&
    body.trim(),
  )
  const unchanged = Boolean(
    view?.draft && subject === view.draft.subject && body === view.draft.body,
  )
  const canReview = Boolean(
    viewMatchesVenue &&
    view?.draft &&
    view.draft.state !== 'STALE' &&
    !held &&
    !pending &&
    unchanged &&
    prepared?.id === view.draft.preparationId,
  )
  const hasUnsavedEditor = editorTouched && Boolean(view?.draft ? !unchanged : subject || body)

  useEffect(() => {
    if (!hasUnsavedEditor) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    const interceptNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const destination = new URL(anchor.href, window.location.href)
      if (
        destination.origin === window.location.origin &&
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash !== ''
      )
        return
      event.preventDefault()
      setRecoveryPrompt({ kind: 'navigation', href: destination.href })
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    document.addEventListener('click', interceptNavigation, true)
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload)
      document.removeEventListener('click', interceptNavigation, true)
    }
  }, [hasUnsavedEditor])

  function storeTemporaryRecovery(): boolean {
    const next = { subject, body }
    if (!writeTemporaryRecovery(venueId, next)) {
      setError(
        'This browser cannot keep a temporary recovery copy. Copy the editor text before leaving.',
      )
      return false
    }
    setTemporaryRecovery(next)
    return true
  }

  function discardTemporaryRecovery() {
    clearTemporaryRecovery(venueId)
    setTemporaryRecovery(null)
  }

  function restoreTemporaryRecovery() {
    if (!temporaryRecovery) return
    setSubject(temporaryRecovery.subject)
    setBody(temporaryRecovery.body)
    setEditorTouched(true)
    discardTemporaryRecovery()
    setMessage(
      'Temporary editor copy restored. It is not a CRM revision; save it for review when ready.',
    )
  }

  function requestReload() {
    if (hasUnsavedEditor) {
      setRecoveryPrompt({ kind: 'reload' })
      return
    }
    void reload()
  }

  function continueFromRecoveryPrompt(keepTemporaryRecovery: boolean) {
    const prompt = recoveryPrompt
    if (!prompt) return
    if (keepTemporaryRecovery && !storeTemporaryRecovery()) return
    setRecoveryPrompt(null)
    if (prompt.kind === 'reload') {
      void reload()
      return
    }
    window.location.assign(prompt.href)
  }

  return (
    <section
      aria-label="Sales preparation and review"
      aria-busy={pending}
      className="min-w-0 border-y-2 border-slate-800 bg-white px-4 py-6 sm:px-6 [overflow-wrap:anywhere]"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-800">
            Prepare / review / state
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">Sales preparation</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Research only what this conversation needs. Keep source facts, contact candidates and
            human review separate.
          </p>
        </div>
        <div className="border-l-4 border-slate-800 pl-3 text-sm font-bold text-slate-950">
          SEND AUTHORIZED: NO
          <p className="mt-1 text-xs font-normal text-slate-600">
            No sender is available in this workflow.
          </p>
        </div>
      </header>
      {local ? (
        <p className="mt-3 text-xs leading-5 text-slate-600">
          Synthetic SYSTEM operator fixture on the retained research database. Review clicks are not
          authenticated as Tom or any human and never create a send approval.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={button} onClick={requestReload} disabled={pending}>
          Reload native state
        </button>
        {pending ? (
          <p role="status" className="text-sm text-slate-600">
            Checking the local source-bound workflow…
          </p>
        ) : null}
      </div>
      {recoveryPrompt ? (
        <section
          aria-label="Unsaved editor recovery"
          className="mt-4 border-l-4 border-amber-700 bg-amber-50 p-3 text-sm leading-6 text-amber-950"
        >
          <p className="font-semibold">Unsaved subject or message body detected.</p>
          <p className="mt-1">
            It is not saved in CRM. You can keep one temporary copy in this browser tab before
            {recoveryPrompt.kind === 'reload' ? ' reloading.' : ' continuing to the next page.'} It
            uses session storage only, never localStorage, and clears when you save, discard it, or
            close this tab.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={button}
              onClick={() => continueFromRecoveryPrompt(true)}
            >
              Keep temporary recovery and {recoveryPrompt.kind === 'reload' ? 'reload' : 'continue'}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => continueFromRecoveryPrompt(false)}
            >
              {recoveryPrompt.kind === 'reload'
                ? 'Reload without recovery'
                : 'Continue without recovery'}
            </button>
            <button type="button" className={button} onClick={() => setRecoveryPrompt(null)}>
              Stay on this page
            </button>
          </div>
        </section>
      ) : null}
      {temporaryRecovery ? (
        <section
          aria-label="Temporary editor recovery"
          className="mt-4 border-l-4 border-sky-700 bg-sky-50 p-3 text-sm leading-6 text-slate-900"
        >
          <p className="font-semibold">An unsaved temporary copy is available.</p>
          <p className="mt-1">
            Restore it only if it is still appropriate for the current CRM context. Restoring does
            not create a revision or approve sending.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" className={button} onClick={restoreTemporaryRecovery}>
              Restore temporary copy
            </button>
            <button type="button" className={button} onClick={discardTemporaryRecovery}>
              Discard temporary copy
            </button>
          </div>
        </section>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-4 border-l-4 border-rose-700 bg-rose-50 p-3 text-sm leading-6 text-rose-950"
        >
          {error} Reload native state before retrying.
        </p>
      ) : null}
      {message ? (
        <p
          role="status"
          className="mt-4 border-l-4 border-emerald-700 bg-emerald-50 p-3 text-sm leading-6 text-emerald-950"
        >
          {message}
        </p>
      ) : null}
      {view ? (
        <>
          <dl className="mt-6 grid gap-x-8 gap-y-4 border-y border-slate-200 py-4 md:grid-cols-3">
            {[
              ['Research sufficiency', view.gate.decision],
              ['Outreach state', view.outreachState],
              ['Correspondence state', view.correspondenceState],
            ].map(([term, value]) => (
              <div key={term}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {term}
                </dt>
                <dd className="mt-2 text-sm font-bold text-slate-950">{label(value!)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-950">
                What we know / what remains unknown
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {view.sourceCount} native source record{view.sourceCount === 1 ? '' : 's'}.{' '}
                {label(view.sourceState)}.
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {view.routing
                  ? 'The public route below is a retained evidence snapshot, not a new verification. Native readiness and permission are unchanged.'
                  : 'No exact Composer source crosswalk is available. Workbook contact candidates are not primary-source verification.'}
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="font-semibold text-slate-800">Routing</dt>
                  <dd className="mt-1 break-all text-slate-700">
                    {view.routing
                      ? `${label(view.routing.kind)} · ${view.routing.value ?? 'No email recipient'}`
                      : 'Unresolved — candidate only'}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-800">Native readiness / permission</dt>
                  <dd className="mt-1 text-slate-700">
                    {view.routing?.readiness ?? 'UNKNOWN'} / {view.routing?.permission ?? 'UNKNOWN'}
                  </dd>
                </div>
              </dl>
              <details className="mt-3 text-sm">
                <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                  Native contact candidates ({view.contacts.length})
                </summary>
                {view.contacts.length ? (
                  <ul className="divide-y divide-slate-200">
                    {view.contacts.map((contact) => (
                      <li key={contact.id} className="py-3 leading-6">
                        <p>
                          {contact.name ?? 'Name not recorded'} ·{' '}
                          <span className="break-all">{contact.email ?? 'Email not recorded'}</span>
                        </p>
                        <p className="text-xs text-slate-600">
                          Readiness {contact.readiness} · permission {contact.permission}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-2 text-slate-600">No contact recorded; none will be guessed.</p>
                )}
              </details>
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-950">Why research is / is not needed</h3>
              {view.gate.decision === 'ENOUGH_EVIDENCE' ? (
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  The original Research Gate found enough bounded evidence for this review-only
                  task. It did not authorize delivery or certify the contact.
                </p>
              ) : null}
              {view.gate.questions.length ? (
                <ol className="mt-3 space-y-3">
                  {view.gate.questions.map((question, index) => (
                    <li
                      key={question.id}
                      className="border-l-2 border-amber-500 pl-3 text-sm leading-6"
                    >
                      <p>
                        <span className="font-semibold">{index + 1}.</span> {question.question}
                      </p>
                      {question.why ? (
                        <p className="mt-1 text-xs text-slate-600">{question.why}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {view.gate.humanQuestions.map((question, index) => (
                <p key={index} className="mt-2 text-sm leading-6 text-amber-950">
                  {question}
                </p>
              ))}
              {view.blocker ? (
                <p className="mt-3 text-sm leading-6 text-amber-950">{view.blocker}</p>
              ) : null}
              <p className="mt-3 text-xs leading-5 text-slate-600">
                No web executor or automatic crawl runs here. Questions stay bounded to the current
                task.
              </p>
            </div>
          </div>
          {held ? (
            <div className="mt-5 border-l-4 border-rose-700 bg-rose-50 p-4 text-sm text-rose-950">
              <h3 className="font-bold">Held / suppressed — preparation blocked</h3>
              {view.suppression.reasons.map((reason, index) => (
                <p key={index} className="mt-2 leading-6">
                  {reason}
                </p>
              ))}
              <p className="mt-2">
                Resolve this through the native hold/suppression owner, not by selecting another
                route here.
              </p>
            </div>
          ) : null}
          {view.evidenceAdmission ? (
            <ProspectEvidenceAdmission
              key={`${view.snapshotHash}:${view.evidenceAdmission.selectionId ?? 'none'}`}
              view={view}
              evidence={view.evidenceAdmission}
              enabled={!pending && !held}
              onAction={action}
            />
          ) : null}
          {view.correspondence ? (
            <section
              className="mt-6 border-t border-slate-200 pt-5"
              aria-label="Correspondence snapshot"
            >
              <h3 className="font-bold text-slate-950">Correspondence snapshot</h3>
              {view.correspondence.synthetic ? (
                <p className="mt-2 font-semibold text-amber-950">
                  SYNTHETIC correspondence. No venue sent these fixture messages.
                </p>
              ) : null}
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {label(view.correspondence.relationship)} · {label(view.correspondence.action)}
              </p>
              {view.correspondence.latestInbound ? (
                <div className="mt-3 border-l-2 border-slate-300 pl-4">
                  <p className="text-xs font-bold uppercase text-slate-600">Latest inbound</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800">
                    {view.correspondence.latestInbound.body}
                  </p>
                </div>
              ) : null}
              {view.correspondence.issues.map((issue, index) => (
                <p key={index} className="mt-2 text-sm text-amber-950">
                  {label(issue)}
                </p>
              ))}
              <p className="mt-2 break-all text-xs text-slate-500">
                Native thread: {view.correspondence.threadId}
              </p>
            </section>
          ) : null}
          <section
            className="mt-6 border-t border-slate-200 pt-5"
            aria-label="Prepare writing context"
          >
            <h3 className="font-bold text-slate-950">Prepare the next message</h3>
            {multipleThreads ? (
              <label className="mt-4 block text-sm font-semibold text-slate-900">
                Exact conversation to answer
                <select
                  className={`${field} max-w-full`}
                  value={selectedThreadId}
                  onChange={(event) => {
                    setSelectedThreadId(event.target.value)
                    setAnswerText('')
                    setAnswerScope(null)
                  }}
                  disabled={pending || held}
                >
                  <option value="">Choose a retained thread</option>
                  {view.threadCandidates.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.id} · {thread.messageCount} messages ·{' '}
                      {thread.sourceComplete ? 'source available' : 'source incomplete'}
                    </option>
                  ))}
                </select>
                <span className="mt-2 block text-xs font-normal leading-5 text-slate-600">
                  Selection binds one existing thread. Its account, route, messages, and current
                  body are checked again before preparation.
                </span>
                {selectedCoverage?.sourceIssues.map((issue) => (
                  <span
                    key={issue}
                    className="mt-1 block text-xs font-normal leading-5 text-amber-950"
                  >
                    {issue}
                  </span>
                ))}
              </label>
            ) : null}
            <ProspectLaunchAttachmentSelection
              assets={view.launchAssets?.available ?? []}
              hold={view.launchAssets?.hold ?? null}
              selected={launchAssetSelection}
              onChange={setLaunchAssetSelection}
              disabled={pending || held}
            />
            {needsAnswer ? (
              <label className="mt-4 block text-sm font-semibold text-slate-900">
                Intended response to the latest inbound point
                <textarea
                  className={field}
                  rows={3}
                  maxLength={2000}
                  value={answerText}
                  onChange={(event) => {
                    setAnswerText(event.target.value)
                    setAnswerScope(currentResponseScope)
                  }}
                  disabled={pending || held}
                />
                <span className="mt-2 block text-xs font-normal leading-5 text-slate-600">
                  Supply the answer or proposal to discuss. This is an operator task constraint, not
                  a new verified fact or an agreed commitment.
                </span>
              </label>
            ) : null}
            <button
              type="button"
              className={`${button} mt-4`}
              disabled={!canPrepare}
              onClick={() =>
                void action({
                  action: 'prepare',
                  input: {
                    venueId,
                    expectedSnapshotHash: view.snapshotHash,
                    ...(launchAssetSelection ? { launchAssetSelection } : {}),
                    ...(needsAnswer ? { answerText } : {}),
                    ...(multipleThreads ? { selectedThreadId } : {}),
                    ...(prepared?.writingReference
                      ? !local &&
                        prepared.writingReference.sourceRef ===
                          'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md'
                        ? {
                            savedWritingGuide: 'torchiko-v0.2',
                            expectedWritingGuideSha256: prepared.writingReference.sha256,
                          }
                        : { writingReference: prepared.writingReference }
                      : {}),
                  },
                })
              }
            >
              Prepare writing context
            </button>
            {savedGuide?.state === 'available' && savedGuide.sha256 ? (
              <>
                <button
                  type="button"
                  className={`${button} ml-0 mt-3 sm:ml-3`}
                  disabled={!canPrepare}
                  onClick={() =>
                    void action({
                      action: 'prepare',
                      input: {
                        venueId,
                        expectedSnapshotHash: view.snapshotHash,
                        ...(launchAssetSelection ? { launchAssetSelection } : {}),
                        savedWritingGuide: 'torchiko-v0.2',
                        expectedWritingGuideSha256: savedGuide.sha256!,
                        ...(needsAnswer ? { answerText } : {}),
                        ...(multipleThreads ? { selectedThreadId } : {}),
                      },
                    })
                  }
                >
                  Prepare with saved Torchiko guide
                </button>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Uses the complete saved guide and installed Write Like Tom for this preparation. A
                  changed guide requires refreshing readiness and choosing it again. This creates
                  writing context, not a generated message or send approval.
                </p>
              </>
            ) : !local ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                The saved guide is not available for selection in this instance. Check writing
                readiness above; an existing preparation retains its original reference.
              </p>
            ) : null}
            {view.draft?.launchAttachments?.length ? (
              <ProspectLaunchAttachmentList
                assets={view.draft.launchAttachments}
                label="Attachments retained with this draft"
              />
            ) : null}
            {prepared ? (
              <div className="mt-4 min-w-0 text-sm">
                <p className="font-semibold text-slate-900">
                  {prepared.stale
                    ? 'Stale preparation — prepare again before saving.'
                    : 'Preparation ready for the writer / operator.'}
                </p>
                <p className="mt-2 leading-6 text-slate-700">Why: {prepared.why}</p>
                <p className="mt-2 leading-6 text-slate-700">
                  Write Like Tom packet bound. Approved Language: {prepared.approvedCount} active,{' '}
                  {prepared.selectedCount} selected.{' '}
                  {prepared.approvedCount === 0
                    ? 'No candidate phrase is being presented as Tom-approved.'
                    : 'Approved wording does not approve this message.'}
                </p>
                <p className="mt-2 leading-6 text-slate-700">
                  Writing reference:{' '}
                  {prepared.writingReference
                    ? `${prepared.writingReference.label}${prepared.writingReference.sourceRef.startsWith('synthetic:') ? ' (synthetic fixture)' : ''}. Its exact selected text stays bound when you prepare again; supply changed material to Codex before using it.`
                    : 'No writing reference was selected for this preparation. Ask Codex to include your saved guide in a new preparation; no approved language entry is required.'}
                </p>
                <details className="mt-2">
                  <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                    Source-bound writer context and packet identities
                  </summary>
                  <pre
                    tabIndex={0}
                    className="max-h-96 min-w-0 overflow-y-auto whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 p-3 text-xs leading-5"
                  >
                    {prepared.writerMarkdown}
                  </pre>
                  <p className="mt-2 break-all text-xs text-slate-600">
                    Native preparation: {prepared.id}
                  </p>
                  <p className="mt-2 break-all text-xs text-slate-600">
                    WLT: {prepared.wltIdentity}
                  </p>
                  {prepared.writingReference ? (
                    <p className="mt-2 break-all text-xs text-slate-600">
                      Selected reference: {prepared.writingReference.sourceRef} · SHA-256{' '}
                      {prepared.writingReference.sha256}
                    </p>
                  ) : null}
                </details>
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                No native writing preparation yet. Resolve the evidence or human-input requirements
                above, then ask Codex to prepare with your selected saved writing guide.
              </p>
            )}
          </section>
          <ProspectWriterRoundtrip
            view={view}
            enabled={!pending && !held}
            onAction={performAction}
            exportTask={async () => {
              const current = await transport.load(venueId)
              if (current.venueId !== venueId || current.snapshotHash !== view.snapshotHash)
                throw new Error(
                  'CRM context changed. Reload native state before exporting a writer task.',
                )
              if (!current.writerTask)
                throw new Error(
                  current.writerHold ?? 'Persist current preparation before exporting',
                )
              return current.writerTask
            }}
          />
          <section
            className="mt-6 border-t border-slate-200 pt-5"
            aria-label="Immutable draft review"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-bold text-slate-950">Draft / response review</h3>
              <p className="text-xs font-semibold text-slate-600">
                Every saved change creates a revision.
              </p>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Write a normal message using the context above, or import a foreground AI candidate.
              Source claims and meaning still require review; importing never approves sending.
            </p>
            <label
              htmlFor={`${controlId}-subject`}
              className="mt-4 block text-sm font-semibold text-slate-900"
            >
              Subject
            </label>
            <input
              id={`${controlId}-subject`}
              className={field}
              value={subject}
              onChange={(event) => {
                setEditorTouched(true)
                setSubject(event.target.value)
              }}
              maxLength={160}
              disabled={pending || held || !prepared || prepared.stale}
            />
            <label
              htmlFor={`${controlId}-body`}
              className="mt-4 block text-sm font-semibold text-slate-900"
            >
              Message body
            </label>
            <textarea
              id={`${controlId}-body`}
              className={field}
              rows={8}
              value={body}
              onChange={(event) => {
                setEditorTouched(true)
                setBody(event.target.value)
              }}
              maxLength={12000}
              disabled={pending || held || !prepared || prepared.stale}
            />
            {view.draft && !unchanged ? (
              <p className="mt-2 text-sm text-amber-950">
                The editor does not match the saved revision. Save a new revision before marking it
                reviewed.
              </p>
            ) : null}
            {view.draft && prepared && prepared.id !== view.draft.preparationId ? (
              <p className="mt-2 text-sm text-amber-950">
                A new context is prepared. Save a revision to bind the message to this context
                before review.
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className={button}
                disabled={!canSave}
                onClick={() =>
                  prepared &&
                  void action({
                    action: 'save',
                    input: {
                      venueId,
                      preparationId: prepared.id,
                      expectedSnapshotHash: view.snapshotHash,
                      expectedDraftId: prepared.expectedDraftId,
                      subject,
                      body,
                    },
                  })
                }
              >
                Save review revision
              </button>
              <button
                type="button"
                className={button}
                disabled={!canReview}
                onClick={() =>
                  view.draft &&
                  void action({
                    action: 'review',
                    input: {
                      venueId,
                      draftId: view.draft.id,
                      contentHash: view.draft.contentHash,
                      expectedSnapshotHash: view.snapshotHash,
                    },
                  })
                }
              >
                Mark exact revision reviewed
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600">
              “Mark exact revision reviewed” records only a read acknowledgment. Claim/meaning
              findings below are a separate review, and neither action approves sending.
            </p>
            {view.draft ? (
              <div className="mt-5 text-sm leading-6 text-slate-700">
                <p className="font-semibold text-slate-950">
                  Revision {view.draft.version} · {label(view.draft.state)}
                </p>
                <p className="mt-2 break-all text-xs">ID: {view.draft.id}</p>
                <p className="break-all text-xs">SHA-256: {view.draft.contentHash}</p>
                {view.draft.warnings.map((warning, index) => (
                  <p key={index} className="mt-2 text-xs leading-5 text-amber-950">
                    {warning}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-600">
                No draft has been recorded for this prospect.
              </p>
            )}
            {view.draft && view.claimReview ? (
              <ProspectClaimMeaningReview
                key={`${view.draft.id}:${view.claimReview.bindingHash}:${view.claimReview.current?.id ?? 'unrecorded'}`}
                view={view}
                review={view.claimReview}
                enabled={canReview}
                local={local}
                onAction={action}
              />
            ) : null}
            {view.revisions.length ? (
              <ProspectOperationalHandoff
                view={view}
                enabled={!pending && !held && unchanged}
                onAction={action}
              />
            ) : null}
            {view.revisions.length ? (
              <details className="mt-3 text-sm">
                <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-700">
                  Retained revision identities ({view.revisions.length})
                </summary>
                <ol className="space-y-3">
                  {view.revisions.map((revision) => (
                    <li
                      key={revision.id}
                      className="border-l-2 border-slate-300 pl-3 text-xs leading-5"
                    >
                      <p>
                        Revision {revision.version} ·{' '}
                        {revision.reviewed ? 'Reviewed — NO SEND' : 'Review required'}
                      </p>
                      <p className="break-all">{revision.id}</p>
                      <p className="break-all">{revision.contentHash}</p>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </section>
        </>
      ) : null}
    </section>
  )
}
