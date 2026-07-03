'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type WeeklyReportEditorProps = {
  tenantId: string
  reportId: string
  initialTitle: string
  initialContent: string
  status: 'GENERATING' | 'DRAFT' | 'PUBLISHED' | 'FAILED'
}

export function WeeklyReportEditor({
  tenantId,
  reportId,
  initialTitle,
  initialContent,
  status,
}: WeeklyReportEditorProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)
  const [currentStatus, setCurrentStatus] = useState(status)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isPublished = currentStatus === 'PUBLISHED'

  async function saveDraft() {
    setPending(true)
    setMessage(null)
    setErrorMessage(null)

    try {
      await clientRef.current!.admin.updateWeeklyReportDraft.mutate({
        tenantId,
        reportId,
        title,
        content,
      })
      setMessage('Draft saved.')
      router.refresh()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save draft.')
    } finally {
      setPending(false)
    }
  }

  async function publishReport() {
    if (!window.confirm('Publish this report to the client dashboard? This cannot be undone.')) {
      return
    }

    setPending(true)
    setMessage(null)
    setErrorMessage(null)

    try {
      await clientRef.current!.admin.publishWeeklyReport.mutate({ tenantId, reportId })
      setCurrentStatus('PUBLISHED')
      setMessage('Report published.')
      router.refresh()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to publish report.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      <label className="block">
        <span className="text-sm font-semibold text-pf-deep">Title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          readOnly={isPublished}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-primary disabled:opacity-60"
        />
      </label>

      <label className="block">
        <span className="text-sm font-semibold text-pf-deep">Report content</span>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          readOnly={isPublished}
          rows={24}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm leading-6 text-pf-deep outline-none transition focus:border-pf-primary"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={pending || isPublished}
          onClick={() => {
            void saveDraft()
          }}
          className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-pf-white px-5 text-sm font-semibold text-pf-primary transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Save Draft'}
        </button>
        <button
          type="button"
          disabled={pending || isPublished}
          onClick={() => {
            void publishReport()
          }}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Publish to Client Dashboard
        </button>
      </div>

      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </div>
  )
}
