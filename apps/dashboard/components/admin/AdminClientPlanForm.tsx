'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createTRPCClient } from '../../lib/trpc'

type AdminClientPlanFormProps = {
  tenantId: string
  currentPlanTier: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function AdminClientPlanForm({ tenantId, currentPlanTier }: AdminClientPlanFormProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }
  const client = clientRef.current

  const [pendingPlan, setPendingPlan] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handlePlanChange(planTier: 'free' | 'pro' | 'enterprise') {
    setPendingPlan(planTier)
    setMessage(null)
    setErrorMessage(null)

    try {
      await client.admin.updateClientPlanTier.mutate({ tenantId, planTier })
      setMessage(`Plan updated to ${planTier}.`)
      router.refresh()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setPendingPlan(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {(
          [
            ['free', 'Free'],
            ['pro', 'Pro'],
            ['enterprise', 'Enterprise'],
          ] as const
        ).map(([tier, label]) => (
          <button
            key={tier}
            type="button"
            disabled={currentPlanTier === tier || pendingPlan !== null}
            onClick={() => {
              void handlePlanChange(tier)
            }}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-deep/70 transition hover:border-pf-accent hover:bg-pf-accent/5 hover:text-pf-primary disabled:cursor-not-allowed disabled:border-pf-light disabled:bg-pf-surface disabled:text-pf-deep/30"
          >
            {pendingPlan === tier ? 'Saving…' : label}
          </button>
        ))}
      </div>

      {message ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {message}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
