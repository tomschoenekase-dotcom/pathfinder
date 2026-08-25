'use client'

import { useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Preview = inferRouterOutputs<AppRouter>['admin']['previewSemanticVenueUpdate']
type PreviewResult = Pick<
  Preview,
  'classification' | 'operationCount' | 'authority' | 'confidence' | 'blockers' | 'questions'
>

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
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      })
      setPreview(next)
    } catch (cause) {
      setPreview(null)
      setError(cause instanceof Error ? cause.message : 'Semantic preview is unavailable.')
    } finally {
      setBusy(false)
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
            onChange={(event) => setRelation(event.target.value as typeof relation)}
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
            onChange={(event) => setCategory(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
          />
        </label>
      </div>
      <label className="mt-3 block text-sm font-medium text-slate-800">
        Visitor-facing title
        <input
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3"
        />
      </label>
      <label className="mt-3 block text-sm font-medium text-slate-800">
        Visitor-facing content
        <textarea
          required
          rows={4}
          maxLength={5000}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 leading-6"
        />
      </label>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => setIsEnabled(event.target.checked)}
        />
        Enabled in canonical knowledge
      </label>
      <button
        type="button"
        disabled={busy || !title.trim() || !category.trim() || !content.trim()}
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
      {preview ? <SemanticUpdatePreviewResult preview={preview} /> : null}
    </section>
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
