'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type BudgetState = {
  configured: boolean
  enabled: boolean
  startsAt: string | null
  endsAt: string | null
  hardLimitUsd: string
  remainingUsd: string
  reservedUsd: string
  committedUsd: string
  revision: number | null
  breachedAt: string | null
  reason: string
  updatedAt: string | null
  updatedBy: string | null
}

type AdminAiCostBudgetFormProps = {
  tenantId: string
  initialState: BudgetState
}

function localDateTimeValue(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function AdminAiCostBudgetForm({ tenantId, initialState }: AdminAiCostBudgetFormProps) {
  const client = useTRPCClient()
  const router = useRouter()
  const [state, setState] = useState(initialState)
  const [enabled, setEnabled] = useState(initialState.enabled)
  const [startsAt, setStartsAt] = useState(localDateTimeValue(initialState.startsAt))
  const [endsAt, setEndsAt] = useState(localDateTimeValue(initialState.endsAt))
  const [hardLimitUsd, setHardLimitUsd] = useState(initialState.hardLimitUsd)
  const [reason, setReason] = useState(initialState.reason)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setState(initialState)
    setEnabled(initialState.enabled)
    setStartsAt(localDateTimeValue(initialState.startsAt))
    setEndsAt(localDateTimeValue(initialState.endsAt))
    setHardLimitUsd(initialState.hardLimitUsd)
    setReason(initialState.reason)
  }, [initialState])

  async function save() {
    if (!startsAt || !endsAt || !hardLimitUsd.trim() || !reason.trim()) {
      setMessage('Enter a limit, start, end, and internal reason.')
      return
    }
    const nextStartsAt = new Date(startsAt)
    const nextEndsAt = new Date(endsAt)
    if (Number.isNaN(nextStartsAt.getTime()) || Number.isNaN(nextEndsAt.getTime())) {
      setMessage('Enter a valid start and end time.')
      return
    }

    setPending(true)
    setMessage(null)
    try {
      const result = await client.admin.setAiCostBudget.mutate({
        tenantId,
        enabled,
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        hardLimitUsd: hardLimitUsd.trim(),
        reason: reason.trim(),
        expectedRevision: state.revision,
      })
      if (!result.configured) throw new Error('Budget configuration was not returned')
      const nextState: BudgetState = {
        configured: true,
        enabled: result.enabled,
        startsAt: result.startsAt.toISOString(),
        endsAt: result.endsAt.toISOString(),
        hardLimitUsd: result.hardLimitUsd,
        remainingUsd: result.remainingUsd,
        reservedUsd: result.reservedUsd,
        committedUsd: result.committedUsd,
        revision: result.revision,
        breachedAt: result.breachedAt?.toISOString() ?? null,
        reason: result.reason,
        updatedAt: result.updatedAt.toISOString(),
        updatedBy: result.updatedBy,
      }
      setState(nextState)
      setMessage(
        result.replayed ? 'Budget already matched this revision.' : 'AI cost budget saved.',
      )
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save AI cost budget.')
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  async function resetWindow() {
    if (!startsAt || !endsAt || !reason.trim()) {
      setMessage('Enter the next window start, end, and internal reason.')
      return
    }
    if (state.revision === null || state.enabled) {
      setMessage('Save the budget as disabled before resetting its accounting window.')
      return
    }
    const nextStartsAt = new Date(startsAt)
    const nextEndsAt = new Date(endsAt)
    if (Number.isNaN(nextStartsAt.getTime()) || Number.isNaN(nextEndsAt.getTime())) {
      setMessage('Enter a valid start and end time.')
      return
    }
    if (
      !window.confirm(
        'Reset committed accounting for this disabled budget and begin a new audited epoch?',
      )
    ) {
      return
    }

    setPending(true)
    setMessage(null)
    try {
      const result = await client.admin.resetAiCostBudgetWindow.mutate({
        tenantId,
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        reason: reason.trim(),
        expectedRevision: state.revision,
      })
      if (!result.configured) throw new Error('Budget configuration was not returned')
      setState({
        configured: true,
        enabled: result.enabled,
        startsAt: result.startsAt.toISOString(),
        endsAt: result.endsAt.toISOString(),
        hardLimitUsd: result.hardLimitUsd,
        remainingUsd: result.remainingUsd,
        reservedUsd: result.reservedUsd,
        committedUsd: result.committedUsd,
        revision: result.revision,
        breachedAt: result.breachedAt?.toISOString() ?? null,
        reason: result.reason,
        updatedAt: result.updatedAt.toISOString(),
        updatedBy: result.updatedBy,
      })
      setMessage('AI cost budget window reset. Review it, then enable it when ready.')
      router.refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to reset AI cost budget window.')
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  const now = Date.now()
  const status = state.breachedAt
    ? 'Fail-closed'
    : !state.enabled
      ? 'Disabled'
      : state.startsAt && new Date(state.startsAt).getTime() > now
        ? 'Scheduled'
        : state.endsAt && new Date(state.endsAt).getTime() <= now
          ? 'Expired / fail-closed'
          : 'Active'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-pf-deep">AI cost budget</h2>
          <p className="mt-1 text-sm leading-6 text-pf-deep/60">
            Atomic pre-provider spend envelope for gateway-accounted AI. Weekly digest and media
            ingestion remain explicitly outside this first coverage version.
          </p>
        </div>
        <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-wider text-pf-deep/60">
          {status}
        </span>
      </div>

      {state.configured ? (
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <p className="rounded-2xl bg-pf-surface p-3 text-pf-deep/70">
            Committed <strong>${state.committedUsd}</strong>
          </p>
          <p className="rounded-2xl bg-pf-surface p-3 text-pf-deep/70">
            Reserved <strong>${state.reservedUsd}</strong>
          </p>
          <p className="rounded-2xl bg-pf-surface p-3 text-pf-deep/70">
            Remaining <strong>${state.remainingUsd}</strong>
          </p>
        </div>
      ) : null}

      <label className="flex items-center gap-3 text-sm font-medium text-pf-deep">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enforce this budget
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-medium text-pf-deep">
          Hard limit (USD)
          <input
            value={hardLimitUsd}
            onChange={(event) => setHardLimitUsd(event.target.value)}
            inputMode="decimal"
            placeholder="100.00000000"
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent"
          />
        </label>
        <label className="text-sm font-medium text-pf-deep">
          Starts
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent"
          />
        </label>
        <label className="text-sm font-medium text-pf-deep">
          Ends
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent"
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-pf-deep">
        Internal reason
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => void save()}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Save AI budget'}
        </button>
        {state.configured && !state.enabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void resetWindow()}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-white px-5 text-sm font-semibold text-pf-deep transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset disabled window
          </button>
        ) : null}
        {state.updatedAt ? (
          <p className="text-xs text-pf-deep/50">
            Revision {state.revision} / changed {new Date(state.updatedAt).toLocaleString()}
            {state.updatedBy ? ` by ${state.updatedBy}` : ''}
          </p>
        ) : null}
      </div>
      {message ? <p className="text-sm text-pf-deep/70">{message}</p> : null}
    </div>
  )
}
