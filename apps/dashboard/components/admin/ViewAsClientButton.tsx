'use client'

import { useState } from 'react'

import { ADMIN_IMPERSONATION_ERROR, setAdminImpersonation } from '../../lib/admin-impersonation'

type ViewAsClientButtonProps = {
  tenantId: string
  tenantName?: string
  label?: string
}

export function ViewAsClientButton({ tenantId, tenantName, label }: ViewAsClientButtonProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleViewAs() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await setAdminImpersonation(tenantId)
      window.location.href = '/'
    } catch {
      setError(ADMIN_IMPERSONATION_ERROR)
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={handleViewAs}
        disabled={pending}
        aria-busy={pending}
        className="min-h-11 rounded-2xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? 'Opening client view…' : (label ?? `View as ${tenantName ?? 'client'} ->`)}
      </button>
      {error ? (
        <p role="alert" className="max-w-xs text-right text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
