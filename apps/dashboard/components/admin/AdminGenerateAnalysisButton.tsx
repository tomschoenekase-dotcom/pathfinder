'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type AdminGenerateAnalysisButtonProps = {
  tenantId: string
  venueId: string
  rangeStart: string
  rangeEnd: string
}

export function AdminGenerateAnalysisButton({
  tenantId,
  venueId,
  rangeStart,
  rangeEnd,
}: AdminGenerateAnalysisButtonProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setErrorMessage(null)

    try {
      const result = await clientRef.current!.admin.generateAnswerAnalysis.mutate({
        tenantId,
        venueId,
        rangeStart,
        rangeEnd,
      })
      router.push(`/admin/clients/${tenantId}/venues/${venueId}/analysis/${result.snapshotId}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to queue analysis.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          void handleClick()
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Queuing...' : 'Generate Analytics Summary'}
      </button>
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </div>
  )
}
