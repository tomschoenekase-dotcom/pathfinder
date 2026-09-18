'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Identity = { id: string; name: string; agentType: string; enabled: boolean }

type Routine = {
  id: string
  routineKey: string
  agentIdentityId: string
  requestedOperation: string
  intervalSeconds: number
  maxAttempts: number
  maxRunsPerDay: number
  perRunBudgetE8Usd: bigint | string | number | null
  dailyBudgetE8Usd: bigint | string | number | null
  requiredWorkerRoles: string[]
  requiredWorkerCapabilities: string[]
  enabled: boolean
  nextRunAt: Date | null
  lastRunAt: Date | null
  lastAgentRunId: string | null
  lastSkipReason: string | null
  createdAt: Date
  updatedAt: Date
  agentIdentity: { id: string; name: string; enabled: boolean }
}

function formatInterval(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function formatDate(value: Date | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

function budgetStatus(routine: Routine) {
  return routine.perRunBudgetE8Usd !== null || routine.dailyBudgetE8Usd !== null
    ? 'Unsupported configuration'
    : 'Not configured in this subset'
}

function errorMessage(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'The routine change could not be confirmed. No run was started.'
}

export function AgentRoutinesView({
  tenantId,
  venueId,
  routines,
  identities,
}: {
  tenantId: string
  venueId: string
  routines: Routine[]
  identities: Identity[]
}) {
  const base = `/admin/clients/${tenantId}/venues/${venueId}/agents`
  return (
    <div className="space-y-8">
      <header className="border-b border-pf-light pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
              Agent workspace / routines
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
              Recurring monitoring
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/65">
              Review bounded, per-venue monitoring definitions and their latest scheduler evidence.
              Creating a definition never starts a run.
            </p>
          </div>
          <Link
            href={`${base}/settings`}
            className="min-h-11 border border-pf-light px-4 py-2 text-sm font-semibold text-pf-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
          >
            AI controls
          </Link>
        </div>
        <nav
          className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold"
          aria-label="Agent workspace"
        >
          <Link
            className="text-pf-deep/55 hover:text-pf-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
            href={base}
          >
            Operations
          </Link>
          <Link
            className="text-pf-deep/55 hover:text-pf-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
            href={`${base}/integrations`}
          >
            Integrations
          </Link>
          <span className="text-pf-primary" aria-current="page">
            Routines
          </span>
        </nav>
      </header>

      <section
        className="border-l-4 border-amber-400 bg-amber-50 px-4 py-4"
        aria-label="Safety status"
      >
        <p className="text-sm font-bold text-amber-950">Default-dark · human enabled</p>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-amber-950/75">
          New definitions start disabled. Enabling one only makes it eligible for the independently
          gated scheduler; it does not call a model, connect a provider, or bypass worker limits.
        </p>
      </section>

      <RoutineCreateForm tenantId={tenantId} venueId={venueId} identities={identities} />

      <RoutineList tenantId={tenantId} venueId={venueId} routines={routines} />
    </div>
  )
}

function RoutineCreateForm({
  tenantId,
  venueId,
  identities,
}: {
  tenantId: string
  venueId: string
  identities: Identity[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [routineKey, setRoutineKey] = useState('')
  const [agentIdentityId, setAgentIdentityId] = useState(
    identities.find((item) => item.enabled)?.id ?? '',
  )
  const [prompt, setPrompt] = useState('')
  const [intervalSeconds, setIntervalSeconds] = useState('3600')
  const [maxRunsPerDay, setMaxRunsPerDay] = useState('24')
  const [roles, setRoles] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!agentIdentityId || pending) return

    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.createAgentRoutine.mutate({
        operationId: globalThis.crypto.randomUUID(),
        tenantId,
        venueId,
        routineKey: routineKey.trim(),
        agentIdentityId,
        prompt: prompt.trim(),
        requestedOperation: 'routine_monitor',
        intervalSeconds: Number(intervalSeconds),
        maxAttempts: 1,
        maxRunsPerDay: Number(maxRunsPerDay),
        requiredWorkerRoles: splitList(roles),
        requiredWorkerCapabilities: splitList(capabilities),
      })
      setRoutineKey('')
      setPrompt('')
      setFeedback(
        result.routine.enabled
          ? 'Definition already existed and remains enabled. No run was started.'
          : result.replayed
            ? 'Definition already existed disabled. No run was started.'
            : 'Definition saved disabled. No run was started.',
      )
      router.refresh()
    } catch (error) {
      setFeedback(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <details
      className="border border-pf-light bg-white"
      open={identities.filter((item) => item.enabled).length === 0}
    >
      <summary className="cursor-pointer list-none px-5 py-4 font-semibold text-pf-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary marker:hidden">
        <span className="mr-2 text-pf-primary">＋</span> Add monitoring definition
        <span className="ml-2 text-sm font-normal text-pf-deep/55">starts disabled</span>
      </summary>
      <form onSubmit={(event) => void submit(event)} className="border-t border-pf-light px-5 py-5">
        <p className="max-w-2xl text-sm leading-6 text-pf-deep/65">
          Keep the prompt read-only and specific to this venue. Worker roles and capabilities are
          recorded as admission limits, not permissions granted by this form.
        </p>
        <p className="mt-4 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          USD budget enforcement: not supported in this subset; use max runs/day and provider-side
          limits.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Routine key
            <input
              required
              pattern="[a-z0-9]+([.-][a-z0-9]+)*"
              value={routineKey}
              onChange={(event) => setRoutineKey(event.target.value)}
              placeholder="venue.freshness"
              className="min-h-11 border border-pf-light px-3 font-normal outline-none focus:border-pf-primary"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Existing identity
            <select
              required
              value={agentIdentityId}
              onChange={(event) => setAgentIdentityId(event.target.value)}
              className="min-h-11 border border-pf-light bg-white px-3 font-normal outline-none focus:border-pf-primary"
              disabled={pending || identities.every((item) => !item.enabled)}
            >
              {identities
                .filter((item) => item.enabled)
                .map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.name} · {identity.agentType.toLowerCase()}
                  </option>
                ))}
              {identities.every((item) => !item.enabled) ? (
                <option value="">No enabled identities</option>
              ) : null}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep md:col-span-2">
            Read-only monitoring prompt
            <textarea
              required
              maxLength={10_000}
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Inspect approved venue evidence and report only material freshness changes; do not edit or publish."
              className="border border-pf-light px-3 py-2 font-normal outline-none focus:border-pf-primary"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Interval (seconds)
            <input
              required
              type="number"
              min={60}
              max={604800}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              className="min-h-11 border border-pf-light px-3 font-normal"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Maximum runs / day
            <input
              required
              type="number"
              min={1}
              max={1440}
              value={maxRunsPerDay}
              onChange={(event) => setMaxRunsPerDay(event.target.value)}
              className="min-h-11 border border-pf-light px-3 font-normal"
            />
          </label>
          <div
            role="group"
            aria-labelledby="routine-max-attempts-label"
            className="grid gap-1.5 text-sm font-semibold text-pf-deep"
          >
            <span id="routine-max-attempts-label">Maximum attempts / run</span>
            <p className="min-h-11 border border-pf-light px-3 py-2 font-normal">
              1 <span className="text-xs text-pf-deep/55">(fixed; retries are not enabled)</span>
            </p>
          </div>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Required worker roles
            <input
              value={roles}
              onChange={(event) => setRoles(event.target.value)}
              placeholder="comma-separated, optional"
              className="min-h-11 border border-pf-light px-3 font-normal"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-pf-deep">
            Required capabilities
            <input
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
              placeholder="comma-separated, optional"
              className="min-h-11 border border-pf-light px-3 font-normal"
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={pending || !agentIdentityId}
            className="min-h-11 bg-pf-deep px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-50"
          >
            {pending ? 'Saving definition…' : 'Save disabled definition'}
          </button>
          <p className="text-xs leading-5 text-pf-deep/55">
            Enabling is a separate, deliberate action below.
          </p>
        </div>
        {feedback ? (
          <p role="status" className="mt-4 text-sm text-pf-deep/75">
            {feedback}
          </p>
        ) : null}
      </form>
    </details>
  )
}

function RoutineList({
  tenantId,
  venueId,
  routines,
}: {
  tenantId: string
  venueId: string
  routines: Routine[]
}) {
  return (
    <section className="border border-pf-light bg-white" aria-labelledby="routine-list-title">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-pf-light px-5 py-4">
        <div>
          <h2 id="routine-list-title" className="text-lg font-semibold text-pf-deep">
            Saved definitions
          </h2>
          <p className="mt-1 text-sm text-pf-deep/55">
            {routines.length} definition{routines.length === 1 ? '' : 's'} · sorted newest first
          </p>
        </div>
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-pf-deep/45">
          No automatic activation
        </span>
      </div>
      {routines.length ? (
        <div className="divide-y divide-pf-light">
          {routines.map((routine) => (
            <RoutineRow key={routine.id} tenantId={tenantId} venueId={venueId} routine={routine} />
          ))}
        </div>
      ) : (
        <p className="px-5 py-10 text-sm text-pf-deep/60">
          No monitoring definitions yet. Add one above; it will remain disabled until a person
          enables it.
        </p>
      )}
    </section>
  )
}

function RoutineRow({
  tenantId,
  venueId,
  routine,
}: {
  tenantId: string
  venueId: string
  routine: Routine
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const attempted = useRef<string | null>(null)
  const nextEnabled = !routine.enabled

  async function setEnabled(enabled: boolean) {
    if (pending) return
    if (!confirming) return setConfirming(true)
    attempted.current = globalThis.crypto.randomUUID()
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.setAgentRoutineEnabled.mutate({
        operationId: attempted.current,
        tenantId,
        venueId,
        routineId: routine.id,
        enabled,
      })
      setFeedback(
        result.routine.enabled
          ? 'Enabled. The routine is now eligible for the independently gated scheduler; no run was started by this action.'
          : 'Disabled. Future runs are no longer eligible.',
      )
      setConfirming(false)
      router.refresh()
    } catch (error) {
      setFeedback(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <article className="px-5 py-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)_auto] xl:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="font-semibold text-pf-deep">{routine.routineKey}</h3>
            <span
              className={`text-xs font-bold uppercase tracking-[0.12em] ${routine.enabled ? 'text-emerald-700' : 'text-pf-deep/45'}`}
            >
              {routine.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p className="mt-1 text-sm text-pf-deep/65">
            {routine.agentIdentity.name} · {routine.requestedOperation}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Interval</dt>
              <dd className="mt-1 font-semibold text-pf-deep/75">
                {formatInterval(routine.intervalSeconds)}
              </dd>
            </div>
            <div>
              <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Runs / day</dt>
              <dd className="mt-1 font-semibold text-pf-deep/75">{routine.maxRunsPerDay}</dd>
            </div>
            <div>
              <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Attempts</dt>
              <dd className="mt-1 font-semibold text-pf-deep/75">{routine.maxAttempts}</dd>
            </div>
            <div>
              <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">USD budget</dt>
              <dd className="mt-1 font-semibold text-pf-deep/75">{budgetStatus(routine)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-5 text-pf-deep/60">
            <span className="font-semibold text-pf-deep/75">Worker limits:</span>{' '}
            {routine.requiredWorkerRoles.length
              ? routine.requiredWorkerRoles.join(', ')
              : 'any role'}{' '}
            ·{' '}
            {routine.requiredWorkerCapabilities.length
              ? routine.requiredWorkerCapabilities.join(', ')
              : 'no capability filter'}
          </p>
        </div>
        <dl className="grid gap-3 border-l border-pf-light pl-4 text-xs">
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Last run</dt>
            <dd className="mt-1 text-pf-deep/70">{formatDate(routine.lastRunAt)}</dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Next eligible</dt>
            <dd className="mt-1 text-pf-deep/70">{formatDate(routine.nextRunAt)}</dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.1em] text-pf-deep/40">Skip reason</dt>
            <dd className="mt-1 text-pf-deep/70">
              {routine.lastSkipReason
                ? routine.lastSkipReason.replaceAll('_', ' ').toLowerCase()
                : '—'}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-start gap-2 xl:justify-end">
          {confirming ? (
            <div
              role="group"
              aria-label={`${nextEnabled ? 'Enable' : 'Disable'} routine confirmation`}
              className="flex flex-wrap items-center gap-2"
            >
              <p
                id={`routine-confirm-${routine.id}`}
                className="basis-full text-xs leading-5 text-pf-deep/65"
              >
                {nextEnabled
                  ? 'This only makes the definition eligible for the independently gated scheduler; it does not start a run.'
                  : 'Future scheduler runs will be skipped; existing runs are not cancelled.'}
              </p>
              <button
                type="button"
                aria-describedby={`routine-confirm-${routine.id}`}
                disabled={pending}
                onClick={() => void setEnabled(nextEnabled)}
                className="min-h-10 bg-pf-deep px-3 text-xs font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-50"
              >
                {pending ? 'Saving…' : `Confirm ${nextEnabled ? 'enable' : 'disable'}`}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirming(false)}
                className="min-h-10 px-2 text-xs font-semibold text-pf-deep/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() => void setEnabled(nextEnabled)}
              className="min-h-10 border border-pf-primary px-3 text-xs font-semibold text-pf-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pf-primary disabled:opacity-50"
            >
              {nextEnabled ? 'Enable routine' : 'Disable routine'}
            </button>
          )}
        </div>
      </div>
      {feedback ? (
        <p role="status" className="mt-4 text-sm text-pf-deep/70">
          {feedback}
        </p>
      ) : null}
    </article>
  )
}

function splitList(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
