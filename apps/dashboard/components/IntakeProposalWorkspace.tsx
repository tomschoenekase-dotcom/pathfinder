'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { StaffInterviewSubmission } from '@pathfinder/contracts/staff-interview'
import { normalizeTorchikoBrandText } from '@pathfinder/ui'

import { useTRPCClient } from '../lib/trpc'
import { browserUuid } from '../lib/browser-uuid'
import { IntakeProposalReview } from './IntakeProposalReview'
import { IntakeBuilderLifecyclePanel } from './admin/IntakeBuilderLifecyclePanel'
import { StaffInterviewCapture, type StaffInterviewDraft } from './StaffInterviewCapture'

type WebsiteDraft = { kind: 'WEBSITE'; displayName: string; websiteUri: string }
type NotesDraft = { kind: 'NOTES'; notes: string }
type DraftContent = WebsiteDraft | NotesDraft | StaffInterviewDraft

export type IntakeProposalSummary = {
  id: string
  sourceKind: string
  status: string
  displayName: string
  websiteUri: string | null
  interviewRole: string | null
  structuredBootstrap?: unknown
  createdAt: Date
  _count: { evidence: number; events: number }
  packageHandoff: { packageDraftId: string; createdAt: Date } | null
}

function optionalNotes(proposal: IntakeProposalSummary): string | null {
  if (
    proposal.sourceKind !== 'STRUCTURED_BOOTSTRAP' ||
    !proposal.structuredBootstrap ||
    typeof proposal.structuredBootstrap !== 'object' ||
    Array.isArray(proposal.structuredBootstrap)
  )
    return null
  const value = proposal.structuredBootstrap as { kind?: unknown; notes?: unknown }
  return value.kind === 'OPTIONAL_NOTES' && typeof value.notes === 'string' ? value.notes : null
}

function proposalSourceLabel(proposal: IntakeProposalSummary): string {
  if (proposal.sourceKind === 'INTERVIEW') return 'Staff answers'
  if (proposal.sourceKind === 'WEBSITE') return 'Website'
  if (optionalNotes(proposal)) return 'Optional notes'
  return 'Onboarding information'
}

function WebsiteProposalCapture({
  disabled,
  clientFacing,
  onSubmit,
  onDirtyChange,
  initialDraft,
  onDraftChange,
}: {
  disabled: boolean
  clientFacing: boolean
  onSubmit: (input: { displayName: string; websiteUri: string; requestId: string }) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  initialDraft?: WebsiteDraft
  onDraftChange?: (draft: WebsiteDraft) => void
}) {
  const [displayName, setDisplayName] = useState(initialDraft?.displayName ?? '')
  const [websiteUri, setWebsiteUri] = useState(initialDraft?.websiteUri ?? '')
  const [requestId, setRequestId] = useState(browserUuid)
  const submittingRef = useRef(false)
  const dirty = Boolean(displayName || websiteUri)

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  useEffect(() => {
    if (!initialDraft) return
    setDisplayName(initialDraft.displayName)
    setWebsiteUri(initialDraft.websiteUri)
  }, [initialDraft])
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (submittingRef.current) return
        submittingRef.current = true
        onDraftChange?.({ kind: 'WEBSITE', displayName, websiteUri })
        void onSubmit({ displayName: displayName.trim(), websiteUri, requestId })
          .then(() => {
            setDisplayName('')
            setWebsiteUri('')
            setRequestId(browserUuid())
            onDirtyChange?.(false)
          })
          .catch(() => undefined)
          .finally(() => {
            submittingRef.current = false
          })
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="font-semibold text-pf-deep">
          {clientFacing ? 'Share a website' : 'Website source proposal'}
        </legend>
        <p className="mt-1 text-sm text-pf-deep/75">
          {clientFacing
            ? 'Add a website address for the Torchiko team to review. Nothing is published from this step.'
            : 'Record an address for later review. This form does not fetch or crawl it.'}
        </p>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          {clientFacing ? 'Website name' : 'Proposal name'}
          <input
            required
            maxLength={255}
            value={displayName}
            onChange={(event) => {
              const next = event.target.value
              setDisplayName(next)
              onDraftChange?.({ kind: 'WEBSITE', displayName: next, websiteUri })
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Website URL
          <input
            required
            type="url"
            maxLength={2000}
            value={websiteUri}
            onChange={(event) => {
              const next = event.target.value
              setWebsiteUri(next)
              onDraftChange?.({ kind: 'WEBSITE', displayName, websiteUri: next })
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
      </fieldset>
      <button
        type="submit"
        disabled={disabled || !displayName.trim() || !websiteUri.trim()}
        className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {disabled
          ? clientFacing
            ? 'Sharing…'
            : 'Recording…'
          : clientFacing
            ? 'Share website'
            : 'Record website proposal'}
      </button>
    </form>
  )
}

function OptionalNotesCapture({
  disabled,
  clientFacing,
  onSubmit,
  onDirtyChange,
  initialDraft,
  onDraftChange,
}: {
  disabled: boolean
  clientFacing: boolean
  onSubmit: (input: { notes: string; requestId: string }) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  initialDraft?: NotesDraft
  onDraftChange?: (draft: NotesDraft) => void
}) {
  const [notes, setNotes] = useState(initialDraft?.notes ?? '')
  const [requestId, setRequestId] = useState(browserUuid)
  const submittingRef = useRef(false)
  const dirty = Boolean(notes)

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  useEffect(() => {
    if (initialDraft) setNotes(initialDraft.notes)
  }, [initialDraft])
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (submittingRef.current) return
        submittingRef.current = true
        onDraftChange?.({ kind: 'NOTES', notes })
        void onSubmit({ notes: notes.trim(), requestId })
          .then(() => {
            setNotes('')
            setRequestId(browserUuid())
            onDirtyChange?.(false)
          })
          .catch(() => undefined)
          .finally(() => {
            submittingRef.current = false
          })
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="font-semibold text-pf-deep">Optional notes</legend>
        <p className="mt-1 text-sm leading-6 text-pf-deep/75">
          {clientFacing
            ? 'Share anything else that would help Torchiko understand your venue—hours exceptions, accessibility details, visitor tips, policies, preferred wording, or information we have missed. Do not include passwords or payment details.'
            : 'Record additional venue context for review. It remains a draft source and is never published directly.'}
        </p>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Notes
          <textarea
            required
            rows={7}
            maxLength={20_000}
            value={notes}
            placeholder="For example: The east entrance is step-free, holiday hours vary, and visitors often ask where to park."
            onChange={(event) => {
              const next = event.target.value
              setNotes(next)
              onDraftChange?.({ kind: 'NOTES', notes: next })
              setRequestId(browserUuid())
            }}
            className="mt-1 w-full rounded-xl border border-pf-light px-3 py-3 leading-6"
          />
        </label>
      </fieldset>
      <button
        type="submit"
        disabled={disabled || !notes.trim()}
        className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {disabled ? 'Sharing…' : clientFacing ? 'Share notes' : 'Record optional notes'}
      </button>
    </form>
  )
}

export function IntakeProposalWorkspace({
  venueId,
  proposals,
  adminTenantId,
}: {
  venueId: string
  proposals: IntakeProposalSummary[]
  adminTenantId?: string
}) {
  const client = useTRPCClient()
  const stableClient = useRef(client).current
  const router = useRouter()
  const clientFacing = !adminTenantId
  const [source, setSource] = useState<'WEBSITE' | 'INTERVIEW' | 'NOTES'>('WEBSITE')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [dirtySources, setDirtySources] = useState({
    WEBSITE: false,
    INTERVIEW: false,
    NOTES: false,
  })
  const creatingRef = useRef(false)
  const revisionsRef = useRef<Record<string, number>>({})
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const writesRef = useRef<Record<string, Promise<number>>>({})
  const scopeGenerationRef = useRef(0)
  const latestDraftsRef = useRef<Partial<Record<'WEBSITE' | 'INTERVIEW' | 'NOTES', DraftContent>>>(
    {},
  )
  const [savedDrafts, setSavedDrafts] = useState<
    Partial<Record<'WEBSITE' | 'INTERVIEW' | 'NOTES', DraftContent>>
  >({})
  const [saveState, setSaveState] = useState<
    'LOADING' | 'IDLE' | 'SAVING' | 'SAVED' | 'ERROR' | 'CONFLICT'
  >(clientFacing ? 'LOADING' : 'IDLE')
  const hasUnfinishedDraft = Object.values(dirtySources).some(Boolean)

  const setDraftDirty = useCallback((draftSource: keyof typeof dirtySources, dirty: boolean) => {
    setDirtySources((current) =>
      current[draftSource] === dirty ? current : { ...current, [draftSource]: dirty },
    )
  }, [])
  const setWebsiteDirty = useCallback(
    (dirty: boolean) => setDraftDirty('WEBSITE', dirty),
    [setDraftDirty],
  )
  const setInterviewDirty = useCallback(
    (dirty: boolean) => setDraftDirty('INTERVIEW', dirty),
    [setDraftDirty],
  )
  const setNotesDirty = useCallback(
    (dirty: boolean) => setDraftDirty('NOTES', dirty),
    [setDraftDirty],
  )

  useEffect(() => {
    if (!hasUnfinishedDraft) return
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [hasUnfinishedDraft])

  useEffect(() => {
    if (!clientFacing) return
    const scopeGeneration = ++scopeGenerationRef.current
    Object.values(timersRef.current).forEach(clearTimeout)
    timersRef.current = {}
    writesRef.current = {}
    revisionsRef.current = {}
    latestDraftsRef.current = {}
    setSavedDrafts({})
    setSaveState('LOADING')
    let active = true
    void Promise.all(
      (['WEBSITE', 'INTERVIEW', 'NOTES'] as const).map(async (sourceKind) => {
        const draft = await stableClient.intake.getSubmissionDraft.query({ venueId, sourceKind })
        return [sourceKind, draft] as const
      }),
    )
      .then((results) => {
        if (!active || scopeGenerationRef.current !== scopeGeneration) return
        const contents: Partial<Record<'WEBSITE' | 'INTERVIEW' | 'NOTES', DraftContent>> = {}
        for (const [sourceKind, draft] of results) {
          if (draft && !draft.submittedAt) {
            contents[sourceKind] = draft.content as DraftContent
            revisionsRef.current[sourceKind] = draft.revision
            latestDraftsRef.current[sourceKind] = draft.content as DraftContent
          }
        }
        setSavedDrafts(contents)
        setSaveState('IDLE')
      })
      .catch(() => {
        if (active) setSaveState('ERROR')
      })
    return () => {
      active = false
    }
  }, [clientFacing, stableClient, venueId])

  const persistDraft = useCallback(
    async (sourceKind: 'WEBSITE' | 'INTERVIEW' | 'NOTES', content: DraftContent) => {
      const generation = scopeGenerationRef.current
      const previous = writesRef.current[sourceKind]
      const write = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(
        async () => {
          if (scopeGenerationRef.current !== generation) throw new Error('Draft scope changed')
          setSaveState('SAVING')
          try {
            const saved = await stableClient.intake.saveSubmissionDraft.mutate({
              venueId,
              sourceKind,
              content,
              expectedRevision: revisionsRef.current[sourceKind] ?? 0,
            })
            if (scopeGenerationRef.current !== generation) throw new Error('Draft scope changed')
            revisionsRef.current[sourceKind] = saved.revision
            setSaveState('SAVED')
            return saved.revision
          } catch (error) {
            if (scopeGenerationRef.current === generation)
              setSaveState(
                error instanceof Error && /changed|conflict/iu.test(error.message)
                  ? 'CONFLICT'
                  : 'ERROR',
              )
            throw error
          }
        },
      )
      writesRef.current[sourceKind] = write
      return write
    },
    [stableClient, venueId],
  )

  const queueDraft = useCallback(
    (sourceKind: 'WEBSITE' | 'INTERVIEW' | 'NOTES', content: DraftContent) => {
      if (!clientFacing) return
      latestDraftsRef.current[sourceKind] = content
      clearTimeout(timersRef.current[sourceKind])
      setSaveState('SAVING')
      timersRef.current[sourceKind] = setTimeout(() => {
        void persistDraft(sourceKind, content).catch(() => undefined)
      }, 700)
    },
    [clientFacing, persistDraft],
  )
  const queueWebsiteDraft = useCallback(
    (draft: WebsiteDraft) => queueDraft('WEBSITE', draft),
    [queueDraft],
  )
  const queueInterviewDraft = useCallback(
    (draft: StaffInterviewDraft) => queueDraft('INTERVIEW', draft),
    [queueDraft],
  )
  const queueNotesDraft = useCallback(
    (draft: NotesDraft) => queueDraft('NOTES', draft),
    [queueDraft],
  )

  useEffect(
    () => () => {
      scopeGenerationRef.current += 1
      Object.values(timersRef.current).forEach(clearTimeout)
    },
    [],
  )

  async function create(
    proposal:
      | {
          kind: 'WEBSITE'
          displayName: string
          websiteUri: string
          requestId: string
        }
      | {
          kind: 'INTERVIEW'
          displayName: string
          requestId: string
          submission: StaffInterviewSubmission
        }
      | {
          kind: 'NOTES'
          notes: string
          requestId: string
        },
  ) {
    if (creatingRef.current) return
    creatingRef.current = true
    setBusy(true)
    setMessage(null)
    try {
      let draftRevision: number | undefined
      if (clientFacing) {
        clearTimeout(timersRef.current[proposal.kind])
        const content = latestDraftsRef.current[proposal.kind]
        if (content) draftRevision = await persistDraft(proposal.kind, content)
      }
      if (adminTenantId) {
        await stableClient.admin.createIntakeProposal.mutate({
          tenantId: adminTenantId,
          venueId,
          ...proposal,
        })
      } else {
        await stableClient.intake.createProposal.mutate({
          venueId,
          ...proposal,
          ...(draftRevision !== undefined ? { draftRevision } : {}),
        })
        delete revisionsRef.current[proposal.kind]
        delete latestDraftsRef.current[proposal.kind]
        setSavedDrafts((current) => ({ ...current, [proposal.kind]: undefined }))
      }
      setMessage(
        clientFacing
          ? 'Information received. The Torchiko team will review it before use.'
          : 'Draft proposal recorded for review. Nothing was approved, applied, or published.',
      )
      router.refresh()
    } catch (error) {
      const failure = clientFacing
        ? 'Torchiko could not receive this information.'
        : error instanceof Error
          ? error.message
          : 'The proposal was not recorded.'
      setMessage(
        clientFacing
          ? `${failure} Your information was not shared.`
          : `${failure} No changes were published.`,
      )
      throw error
    } finally {
      creatingRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-7">
      <section
        id="website-source"
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-labelledby="new-intake-source"
      >
        <h2 id="new-intake-source" className="font-semibold text-pf-deep">
          {clientFacing ? 'Share more information' : 'New draft proposal'}
        </h2>
        <fieldset className="mt-3" disabled={busy}>
          <legend className="sr-only">Choose source type</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                checked={source === 'WEBSITE'}
                onChange={() => setSource('WEBSITE')}
              />{' '}
              Website
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                checked={source === 'INTERVIEW'}
                onChange={() => setSource('INTERVIEW')}
              />{' '}
              {clientFacing ? 'Staff questionnaire' : 'Text interview'}
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                checked={source === 'NOTES'}
                onChange={() => setSource('NOTES')}
              />{' '}
              Optional notes
            </label>
          </div>
        </fieldset>
        <p className="mt-3 text-sm text-pf-deep/70" role="note">
          {clientFacing
            ? 'Your unfinished entries save privately as you type and resume on another signed-in device.'
            : 'Unfinished entries stay on this page while you switch options.'}
        </p>
        {clientFacing ? (
          <p className="mt-2 text-sm text-pf-deep/70" role="status" aria-live="polite">
            {saveState === 'LOADING'
              ? 'Loading saved work…'
              : saveState === 'SAVING'
                ? 'Saving…'
                : saveState === 'SAVED'
                  ? 'Saved'
                  : saveState === 'CONFLICT'
                    ? 'This draft changed elsewhere. Reload before continuing.'
                    : saveState === 'ERROR'
                      ? 'Could not save. Your edits remain on this page; retry by editing again.'
                      : ''}
          </p>
        ) : null}
        <div className="mt-4">
          <div hidden={source !== 'WEBSITE'}>
            <WebsiteProposalCapture
              disabled={busy}
              clientFacing={clientFacing}
              onDirtyChange={setWebsiteDirty}
              {...(savedDrafts.WEBSITE
                ? { initialDraft: savedDrafts.WEBSITE as WebsiteDraft }
                : {})}
              onDraftChange={queueWebsiteDraft}
              onSubmit={(input) => create({ kind: 'WEBSITE', ...input })}
            />
          </div>
          <div hidden={source !== 'INTERVIEW'}>
            <StaffInterviewCapture
              disabled={busy}
              clientFacing={clientFacing}
              onDirtyChange={setInterviewDirty}
              {...(savedDrafts.INTERVIEW
                ? { initialDraft: savedDrafts.INTERVIEW as StaffInterviewDraft }
                : {})}
              onDraftChange={queueInterviewDraft}
              onSubmit={(input) => create({ kind: 'INTERVIEW', ...input })}
            />
          </div>
          <div hidden={source !== 'NOTES'}>
            <OptionalNotesCapture
              disabled={busy}
              clientFacing={clientFacing}
              onDirtyChange={setNotesDirty}
              {...(savedDrafts.NOTES ? { initialDraft: savedDrafts.NOTES as NotesDraft } : {})}
              onDraftChange={queueNotesDraft}
              onSubmit={(input) => create({ kind: 'NOTES', ...input })}
            />
          </div>
        </div>
        <p aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-pf-deep/75">
          {message}
        </p>
      </section>
      <section aria-labelledby="proposal-history">
        <h2 id="proposal-history" className="text-xl font-semibold text-pf-deep">
          {clientFacing ? 'Information shared' : 'Proposal history'}
        </h2>
        {proposals.length ? (
          <ul className="mt-3 space-y-3">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{normalizeTorchikoBrandText(proposal.displayName)}</strong>
                  <span>
                    {clientFacing
                      ? proposal.status === 'AWAITING_REVIEW'
                        ? 'Received'
                        : 'Reviewed'
                      : proposal.status.replaceAll('_', ' ')}
                  </span>
                </div>
                <p className="mt-1 text-sm text-pf-deep/75">
                  {clientFacing ? (
                    <>
                      {proposalSourceLabel(proposal)} ·{' '}
                      {proposal.packageHandoff ? 'Prepared for Torchiko review' : 'Review pending'}
                    </>
                  ) : (
                    <>
                      {proposal.sourceKind.replaceAll('_', ' ')}
                      {proposal.interviewRole
                        ? ` · ${proposal.interviewRole.replaceAll('_', ' ')}`
                        : ''}{' '}
                      · {proposal._count.evidence} evidence record(s) ·{' '}
                      {proposal.packageHandoff
                        ? `Draft package ${proposal.packageHandoff.packageDraftId}`
                        : 'Awaiting review handoff'}
                    </>
                  )}
                </p>
                {adminTenantId ? (
                  <IntakeBuilderLifecyclePanel
                    tenantId={adminTenantId}
                    venueId={venueId}
                    runId={proposal.id}
                  />
                ) : null}
                {proposal.sourceKind === 'INTERVIEW' ? (
                  <IntakeProposalReview
                    venueId={venueId}
                    runId={proposal.id}
                    clientFacing={clientFacing}
                    {...(adminTenantId ? { adminTenantId } : {})}
                  />
                ) : optionalNotes(proposal) ? (
                  <details className="mt-3 rounded-xl bg-pf-surface p-3 text-sm text-pf-deep/80">
                    <summary className="cursor-pointer font-medium">Read submitted notes</summary>
                    <p className="mt-3 whitespace-pre-wrap leading-6">{optionalNotes(proposal)}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/75">
            {clientFacing
              ? 'No websites, staff answers, or optional notes have been shared yet.'
              : 'No intake proposals yet.'}
          </p>
        )}
      </section>
    </div>
  )
}
