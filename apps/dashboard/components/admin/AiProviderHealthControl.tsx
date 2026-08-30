'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type ProviderId = 'anthropic' | 'openai'
type ProviderOverride = {
  provider: ProviderId
  reason: string
  expiresAt: string
  active: boolean
}

type ProviderHealthState = {
  overrides: ProviderOverride[]
  activeUnhealthyProviders: ProviderId[]
  configured: boolean
  malformed: boolean
  updatedAt: string | null
  updatedBy: string | null
}

const providerLabels: Record<ProviderId, string> = {
  anthropic: 'Anthropic text',
  openai: 'OpenAI embeddings',
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  if (!data || typeof data !== 'object' || !('code' in data)) return null
  return typeof data.code === 'string' ? data.code : null
}

export function AiProviderHealthControl({ initialState }: { initialState: ProviderHealthState }) {
  const client = useTRPCClient()
  const router = useRouter()
  const [state, setState] = useState(initialState)
  const [provider, setProvider] = useState<ProviderId>('anthropic')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
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

  useLayoutEffect(() => {
    scopeGeneration.current += 1
    activeAction.current = null
    setState(initialState)
    setReason('')
    setExpiresAt('')
    setPending(false)
    setFeedback(null)
  }, [initialState])

  function startAction() {
    if (activeAction.current !== null) return null
    const action = { scope: scopeGeneration.current, token: ++actionSequence.current }
    activeAction.current = action.token
    setPending(true)
    setFeedback(null)
    return action
  }

  function isCurrent(action: { scope: number; token: number }) {
    return (
      mounted.current &&
      scopeGeneration.current === action.scope &&
      activeAction.current === action.token
    )
  }

  function finish(action: { scope: number; token: number }) {
    if (!isCurrent(action)) return
    activeAction.current = null
    setPending(false)
  }

  async function update(unhealthy: boolean) {
    const normalizedReason = reason.trim()
    const expiry = expiresAt ? new Date(expiresAt) : null
    if (!normalizedReason) {
      setFeedback({ kind: 'error', text: 'Enter an internal reason for this provider change.' })
      return
    }
    if (
      unhealthy &&
      (!expiry || Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now())
    ) {
      setFeedback({ kind: 'error', text: 'Choose a future expiry before excluding a provider.' })
      return
    }

    const action = startAction()
    if (!action) return
    try {
      const result = await client.admin.setAiProviderHealthOverride.mutate({
        provider,
        unhealthy,
        reason: normalizedReason,
        expiresAt: unhealthy ? expiry : null,
        expectedUpdatedAt: state.updatedAt ? new Date(state.updatedAt) : null,
      })
      if (!isCurrent(action)) return
      setState({
        overrides: result.overrides.map((override) => ({
          ...override,
          expiresAt: override.expiresAt.toISOString(),
        })),
        activeUnhealthyProviders: result.activeUnhealthyProviders,
        configured: result.configured,
        malformed: result.malformed,
        updatedAt: result.updatedAt?.toISOString() ?? null,
        updatedBy: result.updatedBy,
      })
      setReason('')
      setExpiresAt('')
      setFeedback({
        kind: 'success',
        text: unhealthy
          ? `${providerLabels[provider]} excluded until the recorded expiry.`
          : `${providerLabels[provider]} restored to eligible routing.`,
      })
      router.refresh()
    } catch (error) {
      if (!isCurrent(action)) return
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'Provider health changed in another session. Reloading authoritative state; review it before retrying.'
            : 'The provider-health update could not be confirmed. Reloading authoritative state; review it before retrying.',
      })
      router.refresh()
    } finally {
      finish(action)
    }
  }

  return (
    <section
      className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm"
      aria-busy={pending}
    >
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
          Provider routing health
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Expiring exclusions</h2>
        <p className="max-w-2xl text-sm leading-6 text-pf-deep/60">
          Temporarily remove a provider from guest-chat text or embedding work across every venue.
          Expiry restores eligibility automatically; this control does not choose an outage
          threshold or contact customers.
        </p>
      </div>

      {state.malformed ? (
        <p
          className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          Provider routing is fail-closed because the stored control is malformed. Record a reviewed
          provider state below to repair it.
        </p>
      ) : null}

      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {(['anthropic', 'openai'] as const).map((id) => {
          const override = state.overrides.find((item) => item.provider === id)
          return (
            <li key={id} className="rounded-2xl border border-pf-light p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-pf-deep">{providerLabels[id]}</span>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ${override?.active ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}
                >
                  {override?.active ? 'Excluded' : 'Eligible'}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-pf-deep/60">
                {override
                  ? `${override.reason} · ${override.active ? 'Expires' : 'Expired'} ${new Date(override.expiresAt).toLocaleString()}`
                  : 'No provider-specific incident override is recorded.'}
              </p>
            </li>
          )
        })}
      </ul>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-pf-deep">
          Provider
          <select
            value={provider}
            disabled={pending}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
            className="mt-2 min-h-11 w-full rounded-2xl border border-pf-light bg-white px-4 text-sm"
          >
            <option value="anthropic">Anthropic text</option>
            <option value="openai">OpenAI embeddings</option>
          </select>
        </label>
        <label className="text-sm font-medium text-pf-deep">
          Exclusion expiry
          <input
            type="datetime-local"
            value={expiresAt}
            disabled={pending}
            onChange={(event) => setExpiresAt(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-2xl border border-pf-light bg-white px-4 text-sm"
          />
        </label>
      </div>
      <label className="mt-4 block text-sm font-medium text-pf-deep">
        Internal reason
        <textarea
          value={reason}
          maxLength={500}
          rows={2}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          className="mt-2 w-full rounded-2xl border border-pf-light bg-white px-4 py-3 text-sm"
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={pending || reason.trim().length === 0 || expiresAt.length === 0}
          onClick={() => void update(true)}
          className="inline-flex min-h-11 items-center rounded-full bg-rose-700 px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Exclude until expiry'}
        </button>
        <button
          type="button"
          disabled={pending || reason.trim().length === 0}
          onClick={() => void update(false)}
          className="inline-flex min-h-11 items-center rounded-full border border-emerald-300 px-5 text-sm font-semibold text-emerald-800 disabled:opacity-50"
        >
          Restore selected provider
        </button>
      </div>
      <p className="mt-3 text-xs text-pf-deep/50">
        {state.updatedAt
          ? `Last changed ${new Date(state.updatedAt).toLocaleString()}${state.updatedBy ? ` by ${state.updatedBy}` : ''}`
          : 'No provider-health control change has been recorded.'}
      </p>
      {feedback ? (
        <p
          className="mt-3 text-sm text-pf-deep/70"
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}
