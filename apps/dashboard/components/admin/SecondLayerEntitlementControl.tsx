'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

export function SecondLayerEntitlementControl({
  tenantId,
  venueId,
  venueName,
  initialEnabled,
  initialUpdatedAt,
}: {
  tenantId: string
  venueId: string
  venueName: string
  initialEnabled: boolean
  initialUpdatedAt: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function toggle() {
    if (pending) return
    const enabled = !initialEnabled
    if (
      !window.confirm(
        `${enabled ? 'Enable' : 'Disable'} the premium second layer for ${venueName}?`,
      )
    )
      return
    setPending(true)
    try {
      await client.admin.setSecondLayerEntitlement.mutate({
        tenantId,
        venueId,
        enabled,
        expectedUpdatedAt: new Date(initialUpdatedAt),
      })
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-accent">
        Premium entitlement
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-pf-deep">Second chatbot layer</h2>
          <p className="mt-1 text-sm text-pf-deep/60">
            Creates a private bearer link and unlocks per-item layer tagging.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => void toggle()}
          className={`min-h-11 rounded-full px-5 text-sm font-semibold text-white disabled:opacity-50 ${initialEnabled ? 'bg-rose-700' : 'bg-emerald-700'}`}
        >
          {pending ? 'Saving…' : initialEnabled ? 'Disable add-on' : 'Enable add-on'}
        </button>
      </div>
    </section>
  )
}
