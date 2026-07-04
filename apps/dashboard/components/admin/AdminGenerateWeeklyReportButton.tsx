'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type AdminGenerateWeeklyReportButtonProps = {
  tenantId: string
  venueId: string
  weekStart: string
  weekEnd: string
}

export function AdminGenerateWeeklyReportButton({
  tenantId,
  venueId,
  weekStart,
  weekEnd,
}: AdminGenerateWeeklyReportButtonProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setErrorMessage(null)

    try {
      const trimmedTitle = title.trim()
      const result = await clientRef.current!.admin.generateWeeklyReportDraft.mutate({
        tenantId,
        venueId,
        weekStart,
        weekEnd,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
      })
      router.push(`/admin/clients/${tenantId}/venues/${venueId}/reports/${result.reportId}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue report.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <label className="grid gap-2 text-sm font-medium text-pf-deep">
        Title (optional)
        <input
          type="text"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="PathFinder Weekly Report"
          className="min-h-10 w-full max-w-md rounded-2xl border border-pf-light bg-pf-surface px-4 text-sm text-pf-deep outline-none transition focus:border-pf-primary"
        />
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void handleClick()
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Queuing...' : 'Generate Report Draft'}
      </button>
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </div>
  )
}
