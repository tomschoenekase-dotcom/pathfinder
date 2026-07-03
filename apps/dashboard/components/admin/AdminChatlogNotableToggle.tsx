'use client'

import { useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type AdminChatlogNotableToggleProps = {
  tenantId: string
  sessionId: string
  initialIsNotable: boolean
}

export function AdminChatlogNotableToggle({
  tenantId,
  sessionId,
  initialIsNotable,
}: AdminChatlogNotableToggleProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const [isNotable, setIsNotable] = useState(initialIsNotable)
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleClick() {
    setPending(true)
    setErrorMessage(null)
    const nextValue = !isNotable

    try {
      await clientRef.current!.admin.setSessionNotable.mutate({
        tenantId,
        sessionId,
        isNotable: nextValue,
      })
      setIsNotable(nextValue)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update session.')
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
        className="inline-flex min-h-10 items-center rounded-full border border-pf-light bg-pf-white px-4 text-sm font-semibold text-pf-primary transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Saving...' : isNotable ? 'Unmark notable' : 'Mark notable'}
      </button>
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </div>
  )
}
