'use client'

import { useReverification } from '@clerk/nextjs'
import { useState } from 'react'

type ConsentBody = {
  params: Record<string, string>
  decision: {
    decision: 'approve' | 'deny'
    allTenants: boolean
    tenantIds: string[]
    capabilities: string[]
    expiresInDays: number
  }
}

async function postConsent(body: ConsentBody) {
  const response = await fetch('/api/operator/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as { redirectTo?: string; error?: string }
}

export function ConsentForm(props: {
  params: Record<string, string>
  tenants: Array<{ id: string; name: string }>
  capabilities: string[]
}) {
  const submit = useReverification(postConsent)
  const [allTenants, setAllTenants] = useState(true)
  const [tenantIds, setTenantIds] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState<string[]>(props.capabilities)
  const [expiresInDays, setExpiresInDays] = useState(90)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(decision: 'approve' | 'deny') {
    setBusy(true)
    setError(null)
    try {
      const result = await submit({
        params: props.params,
        decision: { decision, allTenants, tenantIds, capabilities, expiresInDays },
      })
      if (result?.redirectTo) {
        window.location.assign(result.redirectTo)
        return
      }
      setError(result?.error ?? 'The request could not be completed.')
    } catch {
      setError('Verification was cancelled or failed. Nothing was shared.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]

  return (
    <form className="mt-6 space-y-6" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend className="text-sm font-medium text-slate-900">Clients it can work on</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allTenants}
            onChange={(event) => setAllTenants(event.target.checked)}
          />
          All clients, including new ones
        </label>
        {!allTenants ? (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-slate-200 p-2">
            {props.tenants.map((tenant) => (
              <label key={tenant.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={tenantIds.includes(tenant.id)}
                  onChange={() => setTenantIds((current) => toggle(current, tenant.id))}
                />
                {tenant.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium text-slate-900">Capabilities</legend>
        <div className="mt-2 grid grid-cols-2 gap-1">
          {props.capabilities.map((capability) => (
            <label key={capability} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={capabilities.includes(capability)}
                onChange={() => setCapabilities((current) => toggle(current, capability))}
              />
              <code>{capability}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm">
        <span className="font-medium text-slate-900">Expires after (days, 90 at most)</span>
        <input
          className="mt-1 block w-24 rounded border border-slate-300 px-2 py-1"
          type="number"
          min={1}
          max={90}
          value={expiresInDays}
          onChange={(event) =>
            setExpiresInDays(Math.min(90, Math.max(1, Number(event.target.value) || 1)))
          }
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || capabilities.length === 0 || (!allTenants && tenantIds.length === 0)}
          onClick={() => void decide('approve')}
          className="min-h-11 flex-1 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          Approve connection
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('deny')}
          className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-900"
        >
          Deny
        </button>
      </div>
    </form>
  )
}
