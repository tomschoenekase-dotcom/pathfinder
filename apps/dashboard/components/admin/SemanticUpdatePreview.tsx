'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Preview = inferRouterOutputs<AppRouter>['admin']['previewSemanticVenueUpdate']
type PreviewResult = Pick<
  Preview,
  'classification' | 'operationCount' | 'authority' | 'confidence' | 'blockers' | 'questions'
>

type SemanticDraft = {
  packageId: string
  packageStatus: string
  replayed: boolean
}

type SemanticOperationalDraft = {
  operationalUpdateId: string
  operationalUpdateStatus: string
  replayed: boolean
}

export function SemanticUpdatePreview({
  tenantId,
  venueId,
  proposalId,
  proposalUpdatedAt,
  hasTarget,
}: {
  tenantId: string
  venueId: string
  proposalId: string
  proposalUpdatedAt: Date | string
  hasTarget: boolean
}) {
  const client = useTRPCClient()
  const [open, setOpen] = useState(false)
  const [relation, setRelation] = useState<'NEW_FACT' | 'CORRECTS' | 'SUPERSEDES'>(
    hasTarget ? 'CORRECTS' : 'NEW_FACT',
  )
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const [content, setContent] = useState('')
  const [isEnabled, setIsEnabled] = useState(true)
  const [temporal, setTemporal] = useState(false)
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [operationalUpdateType, setOperationalUpdateType] = useState<
    | 'GENERAL_NOTICE'
    | 'TEMPORARY_CLOSURE'
    | 'UNAVAILABLE_EXHIBIT'
    | 'CHANGED_HOURS'
    | 'MAINTENANCE'
    | 'SPECIAL_EVENT'
    | 'SOLD_OUT_ACTIVITY'
    | 'TEMPORARY_VENDOR_LOCATION'
  >('GENERAL_NOTICE')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [draft, setDraft] = useState<SemanticDraft | null>(null)
  const [operationalDraft, setOperationalDraft] = useState<SemanticOperationalDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  function invalidatePreview() {
    setPreview(null)
    setDraft(null)
    setOperationalDraft(null)
    setError(null)
  }

  async function inspect() {
    setBusy(true)
    setError(null)
    try {
      const next = await client.admin.previewSemanticVenueUpdate.query({
        tenantId,
        venueId,
        proposalId,
        expectedUpdatedAt: new Date(proposalUpdatedAt),
        relation,
        desired: {
          title: title.trim(),
          category: category.trim(),
          content: content.trim(),
          isEnabled,
        },
        ...(temporal
          ? {
              validFrom: new Date(validFrom).toISOString(),
              validUntil: new Date(validUntil).toISOString(),
              operationalUpdateType,
            }
          : {}),
      })
      setPreview(next)
      setDraft(null)
      setOperationalDraft(null)
    } catch (cause) {
      setPreview(null)
      setError(cause instanceof Error ? cause.message : 'Semantic preview is unavailable.')
    } finally {
      setBusy(false)
    }
  }

  async function createOperationalDraft() {
    if (!preview?.operationalUpdateDraft || preview.proposalStatus !== 'APPROVED') return
    setCreating(true)
    setError(null)
    try {
      const created = await client.admin.createSemanticOperationalUpdateDraft.mutate({
        tenantId,
        venueId,
        proposalId,
        expectedUpdatedAt: new Date(proposalUpdatedAt),
        expectedPreviewHash: preview.previewHash,
        relation,
        desired: {
          title: title.trim(),
          category: category.trim(),
          content: content.trim(),
          isEnabled,
        },
        validFrom: new Date(validFrom).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        operationalUpdateType,
      })
      setOperationalDraft(created)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Operational update DRAFT could not be created.',
      )
    } finally {
      setCreating(false)
    }
  }

  async function createDraft() {
    if (!preview?.venuePackagePatch || preview.proposalStatus !== 'APPROVED') return
    setCreating(true)
    setError(null)
    try {
      const created = await client.admin.createSemanticVenueUpdatePackageDraft.mutate({
        tenantId,
        venueId,
        proposalId,
        expectedUpdatedAt: new Date(proposalUpdatedAt),
        expectedPreviewHash: preview.previewHash,
        relation,
        desired: {
          title: title.trim(),
          category: category.trim(),
          content: content.trim(),
          isEnabled,
        },
      })
      setDraft(created)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Package DRAFT could not be created.')
    } finally {
      setCreating(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 min-h-11 rounded-lg border border-violet-200 bg-violet-50 px-4 text-sm font-semibold text-violet-900"
      >
        Build semantic change preview
      </button>
    )
  }

  return (
    <section
      className="mt-4 rounded-xl border border-violet-200 bg-violet-50/60 p-4"
      aria-label="Semantic change preview"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-800">
            Venue Updater
          </p>
          <h2 className="mt-1 font-semibold text-slate-950">Smallest coherent patch</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 rounded-lg px-3 text-sm font-medium text-slate-600"
        >
          Close
        </button>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Normalize the intended visitor-facing fact. This only computes a review preview; it cannot
        approve, apply, or publish anything.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-800">
          Change relationship
          <select
            value={relation}
            onChange={(event) => {
              setRelation(event.target.value as typeof relation)
              invalidatePreview()
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
          >
            <option value="NEW_FACT">Addition</option>
            <option value="CORRECTS">Correction</option>
            <option value="SUPERSEDES">Supersession</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-800">
          Category
          <input
            required
            maxLength={100}
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              invalidatePreview()
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
      </div>
      <label className="mt-3 block text-sm font-medium text-slate-800">
        Visitor-facing title
        <input
          required
          maxLength={temporal ? 60 : 200}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            invalidatePreview()
          }}
          className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-slate-800">
        Visitor-facing content
        <textarea
          required
          rows={4}
          maxLength={temporal ? 300 : 5000}
          value={content}
          onChange={(event) => {
            setContent(event.target.value)
            invalidatePreview()
          }}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 leading-6"
        />
      </label>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => {
            setIsEnabled(event.target.checked)
            invalidatePreview()
          }}
        />
        Enabled in canonical knowledge
      </label>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={temporal}
          onChange={(event) => {
            setTemporal(event.target.checked)
            invalidatePreview()
          }}
        />
        Time-bounded operational fact
      </label>
      {temporal ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-800">
            Starts at
            <input
              type="datetime-local"
              value={validFrom}
              onChange={(event) => {
                setValidFrom(event.target.value)
                invalidatePreview()
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
            />
          </label>
          <label className="text-sm font-medium text-slate-800">
            Expires at
            <input
              type="datetime-local"
              value={validUntil}
              onChange={(event) => {
                setValidUntil(event.target.value)
                invalidatePreview()
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
            />
          </label>
          <label className="text-sm font-medium text-slate-800 sm:col-span-2">
            Operational update type
            <select
              value={operationalUpdateType}
              onChange={(event) => {
                setOperationalUpdateType(event.target.value as typeof operationalUpdateType)
                invalidatePreview()
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
            >
              <option value="GENERAL_NOTICE">General notice</option>
              <option value="TEMPORARY_CLOSURE">Temporary closure</option>
              <option value="UNAVAILABLE_EXHIBIT">Unavailable exhibit</option>
              <option value="CHANGED_HOURS">Changed hours</option>
              <option value="MAINTENANCE">Maintenance</option>
              <option value="SPECIAL_EVENT">Special event</option>
              <option value="SOLD_OUT_ACTIVITY">Sold-out activity</option>
              <option value="TEMPORARY_VENDOR_LOCATION">Temporary vendor location</option>
            </select>
          </label>
        </div>
      ) : null}
      <button
        type="button"
        disabled={
          busy ||
          !title.trim() ||
          !category.trim() ||
          !content.trim() ||
          (temporal && (!validFrom || !validUntil))
        }
        onClick={() => void inspect()}
        className="mt-3 min-h-11 rounded-lg bg-violet-800 px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Computing preview…' : 'Compute semantic preview'}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <>
          <SemanticUpdatePreviewResult preview={preview} />
          {preview.proposalStatus === 'APPROVED' && preview.venuePackagePatch ? (
            <SemanticUpdateDraftAction
              tenantId={tenantId}
              venueId={venueId}
              creating={creating}
              draft={draft}
              onCreate={() => void createDraft()}
            />
          ) : null}
          {preview.proposalStatus === 'APPROVED' && preview.operationalUpdateDraft ? (
            <SemanticOperationalUpdateDraftAction
              creating={creating}
              draft={operationalDraft}
              onCreate={() => void createOperationalDraft()}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

export function SemanticOperationalUpdateDraftAction({
  creating,
  draft,
  onCreate,
}: {
  creating: boolean
  draft: SemanticOperationalDraft | null
  onCreate: () => void
}) {
  return (
    <div className="mt-3 rounded-xl border border-sky-200 bg-white p-4">
      <button
        type="button"
        disabled={creating || Boolean(draft)}
        onClick={onCreate}
        className="min-h-11 rounded-lg bg-sky-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {creating
          ? 'Creating operational DRAFT…'
          : draft
            ? 'Operational DRAFT created'
            : 'Create operational update DRAFT'}
      </button>
      <p className="mt-2 text-xs text-slate-600">
        This creates an inactive DRAFT only. Scheduling and publication remain separate.
      </p>
      {draft ? (
        <p className="mt-3 text-sm text-emerald-800" role="status">
          {draft.replayed ? 'Reconciled existing' : 'Created'} {draft.operationalUpdateStatus}. Open
          Operational Updates to review and schedule it separately.
        </p>
      ) : null}
    </div>
  )
}

export function SemanticUpdateDraftAction({
  tenantId,
  venueId,
  creating,
  draft,
  onCreate,
}: {
  tenantId: string
  venueId: string
  creating: boolean
  draft: SemanticDraft | null
  onCreate: () => void
}) {
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
      <button
        type="button"
        disabled={creating || Boolean(draft)}
        onClick={onCreate}
        className="min-h-11 rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {creating
          ? 'Creating reviewable DRAFT…'
          : draft
            ? 'Reviewable DRAFT created'
            : 'Create reviewable package DRAFT'}
      </button>
      <p className="mt-2 text-xs text-slate-600">
        This creates and links a DRAFT only. Package approval and apply remain separate.
      </p>
      {draft ? (
        <p className="mt-3 text-sm text-emerald-800" role="status">
          {draft.replayed ? 'Reconciled existing' : 'Created'} {draft.packageStatus}{' '}
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/packages`}
            className="font-semibold underline underline-offset-2"
          >
            Open package review
          </Link>
        </p>
      ) : null}
    </div>
  )
}

export function SemanticUpdatePreviewResult({ preview }: { preview: PreviewResult }) {
  const blocked = preview.blockers.length > 0
  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${blocked ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}
      role="status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-950">
          {preview.classification.replaceAll('_', ' ')}
        </p>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-700">
          {preview.operationCount} proposed operation{preview.operationCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-700">
        Authority: {preview.authority.replaceAll('_', ' ').toLowerCase()} · confidence{' '}
        {Math.round(preview.confidence * 100)}%
      </p>
      {preview.blockers.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-950">
          {preview.blockers.map((blocker) => (
            <li key={`${blocker.code}:${blocker.path}`}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      {preview.questions.map((question) => (
        <p key={question.prompt} className="mt-3 text-sm font-medium text-slate-800">
          Clarify with venue operator: {question.prompt}
        </p>
      ))}
      <p className="mt-3 text-xs text-slate-600">
        No destructive delete · no automatic approval, apply, schedule, or publication
      </p>
    </div>
  )
}
