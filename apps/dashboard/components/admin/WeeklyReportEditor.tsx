'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const WEEKLY_REPORT_READ_TIMEOUT_MS = 15_000

type WeeklyReportEditorProps = {
  tenantId: string
  venueId: string
  reportId: string
  initialTitle: string
  initialContent: string
  initialUpdatedAt: string
  status: 'GENERATING' | 'DRAFT' | 'PUBLISHED' | 'FAILED'
}

type PendingAction = 'save' | 'publish' | 'reload'
type Feedback = { kind: 'error' | 'success'; text: string }

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function WeeklyReportEditor({
  tenantId,
  venueId,
  reportId,
  initialTitle,
  initialContent,
  initialUpdatedAt,
  status,
}: WeeklyReportEditorProps) {
  const router = useRouter()
  const client = useTRPCClient()

  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [savedTitle, setSavedTitle] = useState(initialTitle)
  const [savedContent, setSavedContent] = useState(initialContent)
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialUpdatedAt)
  const [currentStatus, setCurrentStatus] = useState(status)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const actionSequence = useRef(0)
  const activeAction = useRef<number | null>(null)
  const activeRead = useRef<AbortController | null>(null)
  const isPublished = currentStatus === 'PUBLISHED'
  const isDraft = currentStatus === 'DRAFT'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeRead.current?.abort()
      activeRead.current = null
      activeAction.current = null
    }
  }, [])

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    activeRead.current?.abort()
    activeRead.current = null
    activeAction.current = null
    setTitle(initialTitle)
    setContent(initialContent)
    setSavedTitle(initialTitle)
    setSavedContent(initialContent)
    setExpectedUpdatedAt(initialUpdatedAt)
    setCurrentStatus(status)
    setPending(null)
    setFeedback(null)
    setRequiresReload(false)
  }, [tenantId, venueId, reportId, initialTitle, initialContent, initialUpdatedAt, status])

  function startAction(kind: PendingAction) {
    if (activeAction.current !== null) return null
    const action = {
      token: ++actionSequence.current,
      scope: scopeGeneration.current,
    }
    activeAction.current = action.token
    setPending(kind)
    return action
  }

  function isCurrentAction(action: { token: number; scope: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finishAction(action: { token: number; scope: number }) {
    if (!isCurrentAction(action)) return
    activeAction.current = null
    setPending(null)
  }

  function restoreError(error: unknown, action: 'save' | 'publish'): Feedback {
    if (errorCode(error) === 'CONFLICT') {
      return {
        kind: 'error',
        text: 'This report changed after the reviewed revision loaded. Reload it before continuing.',
      }
    }
    return {
      kind: 'error',
      text: `The ${action} outcome could not be confirmed. Reload the report before continuing.`,
    }
  }

  async function saveDraft() {
    const action = startAction('save')
    if (!action) return
    const target = { tenantId, venueId, reportId, title, content, expectedUpdatedAt }
    setFeedback(null)
    try {
      const result = await client.admin.updateWeeklyReportDraft.mutate(target)
      if (!isCurrentAction(action)) return
      setExpectedUpdatedAt(result.updatedAt)
      setSavedTitle(target.title)
      setSavedContent(target.content)
      setFeedback({ kind: 'success', text: 'Draft saved.' })
      router.refresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback(restoreError(error, 'save'))
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  async function publishReport() {
    const action = startAction('publish')
    if (!action) return
    if (!window.confirm('Publish this report to the client dashboard? This cannot be undone.')) {
      finishAction(action)
      return
    }
    const target = { tenantId, venueId, reportId, expectedUpdatedAt }
    setFeedback(null)
    try {
      await client.admin.publishWeeklyReport.mutate(target)
      if (!isCurrentAction(action)) return
      setCurrentStatus('PUBLISHED')
      setFeedback({ kind: 'success', text: 'Report published.' })
      router.refresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback(restoreError(error, 'publish'))
      router.refresh()
    } finally {
      finishAction(action)
    }
  }

  async function reloadReport() {
    const action = startAction('reload')
    if (!action) return
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    setFeedback(null)
    try {
      const report = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: WEEKLY_REPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.getWeeklyReport.query({ tenantId, venueId, reportId }, { signal }),
      })
      if (!isCurrentAction(action)) return
      setTitle(report.title)
      setContent(report.content ?? '')
      setSavedTitle(report.title)
      setSavedContent(report.content ?? '')
      setExpectedUpdatedAt(report.updatedAt.toISOString())
      setCurrentStatus(report.status)
      setRequiresReload(false)
      setFeedback({ kind: 'success', text: 'Report reloaded.' })
    } catch {
      if (!isCurrentAction(action)) return
      setFeedback({
        kind: 'error',
        text: 'The report could not be reloaded in time. No further save or publish was attempted. Retry when ready.',
      })
    } finally {
      if (activeRead.current === controller) activeRead.current = null
      finishAction(action)
    }
  }

  const controlsLocked = pending !== null || !isDraft || requiresReload
  const hasUnsavedChanges = title !== savedTitle || content !== savedContent

  return (
    <div
      className="space-y-5 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending !== null}
    >
      <label className="block">
        <span className="text-sm font-semibold text-pf-deep">Title</span>
        <input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            setFeedback(null)
          }}
          disabled={controlsLocked}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-primary disabled:opacity-60"
        />
      </label>

      <label className="block">
        <span className="text-sm font-semibold text-pf-deep">Report content</span>
        <textarea
          value={content}
          onChange={(event) => {
            setContent(event.target.value)
            setFeedback(null)
          }}
          disabled={controlsLocked}
          rows={24}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm leading-6 text-pf-deep outline-none transition focus:border-pf-primary disabled:opacity-60"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={controlsLocked || !hasUnsavedChanges}
          onClick={() => void saveDraft()}
          className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-semibold text-pf-primary transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === 'save' ? 'Saving…' : 'Save Draft'}
        </button>
        <button
          type="button"
          disabled={controlsLocked || hasUnsavedChanges}
          onClick={() => void publishReport()}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === 'publish' ? 'Publishing…' : 'Publish to Client Dashboard'}
        </button>
      </div>

      {hasUnsavedChanges && !isPublished ? (
        <p className="text-sm text-amber-700" role="status">
          Save the draft before publishing so the reviewed content matches the published revision.
        </p>
      ) : null}

      {!isDraft && !isPublished ? (
        <p className="text-sm text-pf-deep/60" role="status">
          {currentStatus === 'GENERATING'
            ? 'This report is still generating and cannot be edited or published yet.'
            : 'This report failed to generate and cannot be edited or published.'}
        </p>
      ) : null}

      {requiresReload && pending === null ? (
        <button
          type="button"
          onClick={() => void reloadReport()}
          className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
        >
          Reload report
        </button>
      ) : null}
      {pending === 'reload' ? (
        <p className="text-sm text-pf-deep/60" role="status">
          Reloading report…
        </p>
      ) : null}
      {feedback ? (
        <p
          className={`text-sm ${feedback.kind === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
