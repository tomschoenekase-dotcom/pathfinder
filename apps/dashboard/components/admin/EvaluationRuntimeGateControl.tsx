'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

const ENABLE_CONFIRMATION = 'ENABLE EVALUATION RUNNER'

type Readiness = {
  apiProcessEnabled: boolean
  durableGlobalEnabled: boolean
  tenantEnabled: boolean
}

function GateStatus({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-4 rounded-xl border border-pf-light bg-white px-3 py-2">
      <span className="text-sm font-medium text-pf-deep">{label}</span>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-bold ${
          enabled ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-100 text-slate-700'
        }`}
      >
        {enabled ? 'Enabled' : 'Off'}
      </span>
    </li>
  )
}

export function EvaluationRuntimeGateControl(props: {
  tenantId: string
  venueId: string
  readiness: Readiness
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const durableEnabled = props.readiness.durableGlobalEnabled && props.readiness.tenantEnabled
  const canEnable = !durableEnabled && confirmation === ENABLE_CONFIRMATION && !busy

  async function setDurableGates(enabled: boolean) {
    if (busy || (enabled && confirmation !== ENABLE_CONFIRMATION)) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await client.admin.setEvaluationRuntimeDurableGates.mutate({
        tenantId: props.tenantId,
        venueId: props.venueId,
        enabled,
        expectedGlobalEnabled: props.readiness.durableGlobalEnabled,
        expectedTenantEnabled: props.readiness.tenantEnabled,
        ...(enabled ? { confirmation } : {}),
      })
      setConfirmation('')
      setMessage(
        result.executionEnabled
          ? 'All three gates are enabled for this tenant.'
          : enabled
            ? 'Durable gates enabled. The separate Railway process gate remains off.'
            : 'Durable gates disabled. New evaluation execution is closed.',
      )
      router.refresh()
    } catch {
      setMessage('Gate state was not changed. Refresh readiness before trying again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-3xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm sm:p-6"
      aria-labelledby="evaluation-runtime-gates-heading"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-800">
            Execution safety
          </p>
          <h3
            id="evaluation-runtime-gates-heading"
            className="mt-1 text-xl font-semibold text-pf-deep"
          >
            Evaluation runtime gates
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Execution requires all three gates. This control changes the durable global intent and
            this exact tenant together; it never changes the Railway process environment.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
            <GateStatus label="Railway API process" enabled={props.readiness.apiProcessEnabled} />
            <GateStatus
              label="Durable global intent"
              enabled={props.readiness.durableGlobalEnabled}
            />
            <GateStatus label="This tenant" enabled={props.readiness.tenantEnabled} />
          </ul>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-white p-4">
          {durableEnabled ? (
            <>
              <h4 className="font-semibold text-pf-deep">Close durable execution</h4>
              <p className="mt-2 text-sm leading-6 text-pf-deep/70">
                This turns off this tenant and the shared durable global gate. Running work still
                rechecks cancellation and budget controls.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void setDurableGates(false)}
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-rose-700 px-4 text-sm font-bold text-white transition hover:bg-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Closing…' : 'Disable durable gates'}
              </button>
            </>
          ) : (
            <>
              <h4 className="font-semibold text-pf-deep">Open a bounded evaluation window</h4>
              <p className="mt-2 text-sm leading-6 text-pf-deep/70">
                Type the exact phrase below. Other tenants remain off unless separately enabled. The
                global gate is shared platform intent.
              </p>
              <label
                className="mt-4 block text-sm font-semibold text-pf-deep"
                htmlFor="gate-confirmation"
              >
                Type {ENABLE_CONFIRMATION}
              </label>
              <input
                id="gate-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-2 min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 font-mono text-sm text-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              />
              <button
                type="button"
                disabled={!canEnable}
                onClick={() => void setDurableGates(true)}
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-pf-primary px-4 text-sm font-bold text-white transition hover:bg-pf-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Enabling…' : 'Enable durable gates'}
              </button>
            </>
          )}
          {message ? (
            <p className="mt-3 text-sm font-medium text-pf-deep" role="status">
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
