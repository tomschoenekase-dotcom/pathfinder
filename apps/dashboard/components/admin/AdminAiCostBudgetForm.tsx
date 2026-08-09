'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

type PendingAction = 'save' | 'reset' | 'reload'
type Feedback = { kind: 'error' | 'success'; text: string }

function localDateTimeValue(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

function configuredBudgetState(result: {
  configured: true
  enabled: boolean
  startsAt: Date
  endsAt: Date
  hardLimitUsd: string
  remainingUsd: string
  reservedUsd: string
  committedUsd: string
  revision: number
  breachedAt: Date | null
  reason: string
  updatedAt: Date
  updatedBy: string
}): BudgetState {
  return {
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
}

function unconfiguredBudgetState(): BudgetState {
  return {
    configured: false,
    enabled: false,
    startsAt: null,
    endsAt: null,
    hardLimitUsd: '',
    remainingUsd: '0.00000000',
    reservedUsd: '0.00000000',
    committedUsd: '0.00000000',
    revision: null,
    breachedAt: null,
    reason: '',
    updatedAt: null,
    updatedBy: null,
  }
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
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [requiresReload, setRequiresReload] = useState(false)
  const mounted = useRef(false)
  const scopeGeneration = useRef(0)
  const actionSequence = useRef(0)
  const activeAction = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeAction.current = null
    }
  }, [])

  function installState(nextState: BudgetState) {
    setState(nextState)
    setEnabled(nextState.enabled)
    setStartsAt(localDateTimeValue(nextState.startsAt))
    setEndsAt(localDateTimeValue(nextState.endsAt))
    setHardLimitUsd(nextState.hardLimitUsd)
    setReason(nextState.reason)
  }

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    activeAction.current = null
    installState(initialState)
    setPending(null)
    setFeedback(null)
    setRequiresReload(false)
  }, [tenantId, initialState])

  function startAction(kind: PendingAction) {
    if (activeAction.current !== null) return null
    const action = { token: ++actionSequence.current, scope: scopeGeneration.current }
    activeAction.current = action.token
    setPending(kind)
    return action
  }

  function isCurrentAction(action: { token: number; scope: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finishAction(action: { token: number; scope: number }) {
    if (!isCurrentAction(action)) return
    activeAction.current = null
    setPending(null)
  }

  function bestEffortRefresh() {
    try {
      router.refresh()
    } catch {
      // The mutation or reconciliation result remains authoritative for this mounted scope.
    }
  }

  function mutationFailure(error: unknown, action: 'save' | 'reset'): Feedback {
    if (errorCode(error) === 'CONFLICT') {
      return {
        kind: 'error',
        text: 'The AI cost budget changed after this view loaded. Reload it before continuing.',
      }
    }
    return {
      kind: 'error',
      text: `The ${action} outcome could not be confirmed. Reload the AI cost budget before continuing.`,
    }
  }

  async function save() {
    const action = startAction('save')
    if (!action) return
    if (!startsAt || !endsAt || !hardLimitUsd.trim() || !reason.trim()) {
      setFeedback({ kind: 'error', text: 'Enter a limit, start, end, and internal reason.' })
      finishAction(action)
      return
    }
    const nextStartsAt = new Date(startsAt)
    const nextEndsAt = new Date(endsAt)
    if (Number.isNaN(nextStartsAt.getTime()) || Number.isNaN(nextEndsAt.getTime())) {
      setFeedback({ kind: 'error', text: 'Enter a valid start and end time.' })
      finishAction(action)
      return
    }
    const target = {
      tenantId,
      enabled,
      startsAt: nextStartsAt,
      endsAt: nextEndsAt,
      hardLimitUsd: hardLimitUsd.trim(),
      reason: reason.trim(),
      expectedRevision: state.revision,
    }
    setFeedback(null)
    try {
      const result = await client.admin.setAiCostBudget.mutate(target)
      if (!isCurrentAction(action)) return
      if (!result.configured) throw new Error('Budget configuration was not returned')
      installState(configuredBudgetState(result))
      setFeedback({
        kind: 'success',
        text: result.replayed ? 'Budget already matched this revision.' : 'AI cost budget saved.',
      })
      bestEffortRefresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback(mutationFailure(error, 'save'))
      bestEffortRefresh()
    } finally {
      finishAction(action)
    }
  }

  async function resetWindow() {
    const action = startAction('reset')
    if (!action) return
    if (!startsAt || !endsAt || !reason.trim()) {
      setFeedback({ kind: 'error', text: 'Enter the next window start, end, and internal reason.' })
      finishAction(action)
      return
    }
    if (state.revision === null || state.enabled || enabled) {
      setFeedback({
        kind: 'error',
        text: 'Save the budget as disabled before resetting its accounting window.',
      })
      finishAction(action)
      return
    }
    const nextStartsAt = new Date(startsAt)
    const nextEndsAt = new Date(endsAt)
    if (Number.isNaN(nextStartsAt.getTime()) || Number.isNaN(nextEndsAt.getTime())) {
      setFeedback({ kind: 'error', text: 'Enter a valid start and end time.' })
      finishAction(action)
      return
    }
    if (
      !window.confirm(
        'Reset committed accounting for this disabled budget and begin a new audited epoch?',
      )
    ) {
      finishAction(action)
      return
    }
    const target = {
      tenantId,
      startsAt: nextStartsAt,
      endsAt: nextEndsAt,
      reason: reason.trim(),
      expectedRevision: state.revision,
    }
    setFeedback(null)
    try {
      const result = await client.admin.resetAiCostBudgetWindow.mutate(target)
      if (!isCurrentAction(action)) return
      if (!result.configured) throw new Error('Budget configuration was not returned')
      installState(configuredBudgetState(result))
      setFeedback({
        kind: 'success',
        text: 'AI cost budget window reset. Review it, then enable it when ready.',
      })
      bestEffortRefresh()
    } catch (error) {
      if (!isCurrentAction(action)) return
      setRequiresReload(true)
      setFeedback(mutationFailure(error, 'reset'))
      bestEffortRefresh()
    } finally {
      finishAction(action)
    }
  }

  async function reloadBudget() {
    const action = startAction('reload')
    if (!action) return
    setFeedback(null)
    try {
      const result = await client.admin.getAiCostBudget.query({ tenantId })
      if (!isCurrentAction(action)) return
      installState(result.configured ? configuredBudgetState(result) : unconfiguredBudgetState())
      setRequiresReload(false)
      setFeedback({ kind: 'success', text: 'AI cost budget reloaded.' })
    } catch {
      if (!isCurrentAction(action)) return
      setFeedback({
        kind: 'error',
        text: 'The AI cost budget could not be reloaded. No further change was attempted.',
      })
    } finally {
      finishAction(action)
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
  const controlsLocked = pending !== null || requiresReload

  return (
    <div className="space-y-4" aria-busy={pending !== null}>
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
          disabled={controlsLocked}
          onChange={(event) => {
            setEnabled(event.target.checked)
            setFeedback(null)
          }}
        />
        Enforce this budget
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm font-medium text-pf-deep">
          Hard limit (USD)
          <input
            value={hardLimitUsd}
            disabled={controlsLocked}
            onChange={(event) => {
              setHardLimitUsd(event.target.value)
              setFeedback(null)
            }}
            inputMode="decimal"
            placeholder="100.00000000"
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent disabled:opacity-60"
          />
        </label>
        <label className="text-sm font-medium text-pf-deep">
          Starts
          <input
            type="datetime-local"
            value={startsAt}
            disabled={controlsLocked}
            onChange={(event) => {
              setStartsAt(event.target.value)
              setFeedback(null)
            }}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent disabled:opacity-60"
          />
        </label>
        <label className="text-sm font-medium text-pf-deep">
          Ends
          <input
            type="datetime-local"
            value={endsAt}
            disabled={controlsLocked}
            onChange={(event) => {
              setEndsAt(event.target.value)
              setFeedback(null)
            }}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent disabled:opacity-60"
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-pf-deep">
        Internal reason
        <textarea
          value={reason}
          disabled={controlsLocked}
          onChange={(event) => {
            setReason(event.target.value)
            setFeedback(null)
          }}
          rows={2}
          maxLength={500}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm outline-none focus:border-pf-accent disabled:opacity-60"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={controlsLocked}
          onClick={() => void save()}
          className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending === 'save' ? 'Saving…' : 'Save AI budget'}
        </button>
        {state.configured && !state.enabled ? (
          <button
            type="button"
            disabled={controlsLocked || enabled}
            onClick={() => void resetWindow()}
            className="inline-flex min-h-11 items-center rounded-full border border-pf-light bg-white px-5 text-sm font-semibold text-pf-deep transition hover:border-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === 'reset' ? 'Resetting…' : 'Reset disabled window'}
          </button>
        ) : null}
        {state.updatedAt ? (
          <p className="text-xs text-pf-deep/50">
            Revision {state.revision} / changed {new Date(state.updatedAt).toLocaleString()}
            {state.updatedBy ? ` by ${state.updatedBy}` : ''}
          </p>
        ) : null}
      </div>
      {requiresReload && pending === null ? (
        <button
          type="button"
          onClick={() => void reloadBudget()}
          className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary"
        >
          Reload AI cost budget
        </button>
      ) : null}
      {pending === 'reload' ? (
        <p className="text-sm text-pf-deep/60" role="status">
          Reloading AI cost budget…
        </p>
      ) : null}
      {feedback ? (
        <p
          className="text-sm text-pf-deep/70"
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
