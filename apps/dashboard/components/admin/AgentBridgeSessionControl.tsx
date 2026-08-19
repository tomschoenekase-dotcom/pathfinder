'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export function AgentBridgeSessionControl(props: {
  tenantId: string
  venueId: string
  sessionId: string
  revoked: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  if (props.revoked) return <span className="text-xs font-semibold text-pf-deep/50">Revoked</span>
  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={busy}
        className="text-xs font-semibold text-rose-700 underline underline-offset-2 disabled:opacity-50"
        onClick={async () => {
          setBusy(true)
          setMessage(null)
          try {
            await client.admin.revokeAgentBridgeSession.mutate({
              tenantId: props.tenantId,
              venueId: props.venueId,
              sessionId: props.sessionId,
              reason: 'Disconnected from the Agent workspace.',
            })
            setMessage('Runner disconnected.')
            router.refresh()
          } catch {
            setMessage('Runner was not disconnected. Refresh and try again.')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Disconnecting…' : 'Disconnect runner'}
      </button>
      {message ? (
        <p role="status" className="mt-1 text-xs text-pf-deep/60">
          {message}
        </p>
      ) : null}
    </div>
  )
}
