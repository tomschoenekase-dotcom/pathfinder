'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import {
  AdminBillingView,
  type AdminBillingState,
  type AdminBillingViewModel,
} from './AdminBillingView'

export function AdminBillingActionsView({
  tenantId,
  state,
  billing,
}: {
  tenantId: string
  state: AdminBillingState
  billing: AdminBillingViewModel | null
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function action(actionId: string) {
    if (actionId !== 'reconcile') return
    setBusy(true)
    setError(null)
    try {
      await client.admin.reconcileClientBilling.mutate({ tenantId })
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Billing reconciliation failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div aria-busy={busy || undefined}>
      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        >
          {error}
        </p>
      ) : null}
      <AdminBillingView
        state={state}
        billing={billing}
        onAction={(actionId) => void action(actionId)}
      />
    </div>
  )
}
