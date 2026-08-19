'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type RolloutFlag = {
  tenantFlagKey: string
  label: string
  description: string
  globalEnabled: boolean
  tenantEnabled: boolean
  effective: boolean
}

export function AdminTochiRolloutForm({
  tenantId,
  flags,
}: {
  tenantId: string
  flags: RolloutFlag[]
}) {
  const router = useRouter()
  const client = useTRPCClient()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function update(flag: RolloutFlag) {
    if (pending) return
    setPending(flag.tenantFlagKey)
    setError(null)
    try {
      await client.admin.setTochiTenantFlag.mutate({
        tenantId,
        flagKey: flag.tenantFlagKey,
        enabled: !flag.tenantEnabled,
      })
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Rollout setting could not be saved.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="divide-y divide-pf-light border-y border-pf-light">
      {flags.map((flag) => (
        <div
          key={flag.tenantFlagKey}
          className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-pf-deep">{flag.label}</h3>
              <span
                className={`text-[0.68rem] font-bold uppercase tracking-[0.12em] ${flag.effective ? 'text-emerald-700' : 'text-pf-deep/70'}`}
              >
                {flag.effective ? 'Effective' : 'Not effective'}
              </span>
            </div>
            <p className="mt-1 text-sm leading-5 text-pf-deep/65">{flag.description}</p>
            <p className="mt-1 text-xs text-pf-deep/70">
              Server kill switch: {flag.globalEnabled ? 'on' : 'off'} · Client allowlist:{' '}
              {flag.tenantEnabled ? 'on' : 'off'}
            </p>
          </div>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void update(flag)}
            className="inline-flex min-h-11 items-center justify-center border border-pf-primary px-4 text-sm font-semibold text-pf-primary transition hover:bg-pf-primary hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            {pending === flag.tenantFlagKey
              ? 'Saving…'
              : flag.tenantEnabled
                ? 'Remove client access'
                : 'Allow for this client'}
          </button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="py-3 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
