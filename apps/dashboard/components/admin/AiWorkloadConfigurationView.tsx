'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { useTRPCClient } from '../../lib/trpc'

type Data = inferRouterOutputs<AppRouter>['admin']['getVenueAiWorkloadConfiguration']
type Workload = Data['workloads'][number]

function formatRate(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
}

function VenueOverrideEditor({ workload, scope }: { workload: Workload; scope: Data['scope'] }) {
  const client = useTRPCClient()
  const router = useRouter()
  const current = workload.overrides.venue
  const [enabled, setEnabled] = useState(current?.enabled ?? false)
  const [timeoutMs, setTimeoutMs] = useState(
    current?.values.timeoutMs?.toString() ?? workload.effective.timeoutMs.toString(),
  )
  const [overrideTimeout, setOverrideTimeout] = useState(current?.values.timeoutMs !== undefined)
  const [maxAttempts, setMaxAttempts] = useState(
    current?.values.maxAttempts?.toString() ?? workload.effective.maxAttempts.toString(),
  )
  const [overrideMaxAttempts, setOverrideMaxAttempts] = useState(
    current?.values.maxAttempts !== undefined,
  )
  const [primaryModelKey, setPrimaryModelKey] = useState<Workload['workloadId'] | ''>(
    current?.values.primaryModelKey ?? '',
  )
  const [fallbackMode, setFallbackMode] = useState<'inherit' | 'disabled' | 'enabled'>(
    current?.values.fallback === undefined
      ? 'inherit'
      : current.values.fallback.enabled
        ? 'enabled'
        : 'disabled',
  )
  const [fallbackModelKey, setFallbackModelKey] = useState<Workload['workloadId'] | ''>(
    current?.values.fallback?.modelKeys[0] ?? '',
  )
  const [maxOutputTokensMode, setMaxOutputTokensMode] = useState<'inherit' | 'limit' | 'unbounded'>(
    current?.values.maxOutputTokens === undefined
      ? 'inherit'
      : current.values.maxOutputTokens === null
        ? 'unbounded'
        : 'limit',
  )
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    current?.values.maxOutputTokens?.toString() ??
      workload.effective.maxOutputTokens?.toString() ??
      '',
  )
  const [budgetMode, setBudgetMode] = useState<'inherit' | 'limit' | 'unbounded'>(
    current?.values.requestBudgetCeilingE8Usd === undefined
      ? 'inherit'
      : current.values.requestBudgetCeilingE8Usd === null
        ? 'unbounded'
        : 'limit',
  )
  const [budget, setBudget] = useState(
    current?.values.requestBudgetCeilingE8Usd ?? workload.effective.requestBudgetCeilingE8Usd ?? '',
  )
  const [unsafe, setUnsafe] = useState(false)
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selectedKeys = [
    ...(primaryModelKey ? [primaryModelKey] : []),
    ...(fallbackMode === 'enabled' && fallbackModelKey ? [fallbackModelKey] : []),
  ]
  const hasUnavailableSelectedRoute = selectedKeys.some(
    (key) => workload.modelOptions.find((option) => option.key === key)?.available !== true,
  )
  const hasIncompleteOverride =
    (fallbackMode === 'enabled' && !fallbackModelKey) ||
    (overrideTimeout &&
      (!Number.isInteger(Number(timeoutMs)) ||
        Number(timeoutMs) < 100 ||
        Number(timeoutMs) > 120_000)) ||
    (overrideMaxAttempts &&
      (!Number.isInteger(Number(maxAttempts)) ||
        Number(maxAttempts) < 1 ||
        Number(maxAttempts) > 5)) ||
    (maxOutputTokensMode === 'limit' &&
      (!Number.isInteger(Number(maxOutputTokens)) ||
        Number(maxOutputTokens) < 1 ||
        Number(maxOutputTokens) > 32_000)) ||
    (budgetMode === 'limit' && !/^\d+$/u.test(budget.trim()))

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      await client.admin.saveAiWorkloadConfigurationOverride.mutate({
        scope: { level: 'VENUE', ...scope, workloadId: workload.workloadId },
        expectedRevision: current?.revision ?? null,
        enabled,
        values: {
          ...(primaryModelKey ? { primaryModelKey } : {}),
          ...(fallbackMode === 'inherit'
            ? {}
            : {
                fallback: {
                  enabled: fallbackMode === 'enabled',
                  modelKeys:
                    fallbackMode === 'enabled' && fallbackModelKey ? [fallbackModelKey] : [],
                },
              }),
          ...(overrideTimeout ? { timeoutMs: Number(timeoutMs) } : {}),
          ...(overrideMaxAttempts ? { maxAttempts: Number(maxAttempts) } : {}),
          ...(maxOutputTokensMode === 'inherit'
            ? {}
            : {
                maxOutputTokens:
                  maxOutputTokensMode === 'unbounded' ? null : Number(maxOutputTokens),
              }),
          ...(budgetMode === 'inherit'
            ? {}
            : {
                requestBudgetCeilingE8Usd: budgetMode === 'unbounded' ? null : budget.trim(),
              }),
        },
        unsafeChangesEnabled: unsafe,
        reason,
      })
      setStatus('Staged override saved. Provider execution was not triggered.')
      router.refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save staged override.')
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    if (!current) return
    setBusy(true)
    setStatus(null)
    try {
      await client.admin.resetAiWorkloadConfigurationOverride.mutate({
        scope: { level: 'VENUE', ...scope, workloadId: workload.workloadId },
        expectedRevision: current.revision,
        reason,
      })
      setStatus('Venue override reset to inherited configuration.')
      router.refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to reset override.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-5 rounded-xl border border-pf-light bg-pf-surface/50 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-pf-deep">
        Edit venue override {current ? `· revision ${current.revision}` : '· not created'}
      </summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm font-medium text-pf-deep sm:col-span-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable this staged venue override
        </label>
        <label className="text-xs font-medium text-pf-deep sm:col-span-2">
          Primary logical model key (blank inherits)
          <select
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            value={primaryModelKey}
            onChange={(event) =>
              setPrimaryModelKey(event.target.value as Workload['workloadId'] | '')
            }
          >
            <option value="">Inherit</option>
            {workload.modelOptions.map((option) => (
              <option key={option.key} value={option.key} disabled={!option.available}>
                {option.key} · {option.provider}/{option.model}
                {option.available ? '' : ' · unavailable to admin control'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-pf-deep">
          Fallback behavior
          <select
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            value={fallbackMode}
            onChange={(event) =>
              setFallbackMode(event.target.value as 'inherit' | 'disabled' | 'enabled')
            }
          >
            <option value="inherit">Inherit</option>
            <option value="disabled">Disabled for this venue</option>
            <option value="enabled">Enabled for this venue</option>
          </select>
        </label>
        <label className="text-xs font-medium text-pf-deep">
          Fallback logical key
          <select
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            value={fallbackModelKey}
            disabled={fallbackMode !== 'enabled'}
            onChange={(event) =>
              setFallbackModelKey(event.target.value as Workload['workloadId'] | '')
            }
          >
            <option value="">None</option>
            {workload.modelOptions.map((option) => (
              <option key={option.key} value={option.key} disabled={!option.available}>
                {option.key}
                {option.available ? '' : ' · unavailable to admin control'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-pf-deep sm:col-span-2">
          <input
            type="checkbox"
            checked={overrideTimeout}
            onChange={(event) => setOverrideTimeout(event.target.checked)}
          />
          Use venue-specific timeout
        </label>
        <label className="text-xs font-medium text-pf-deep">
          Timeout (ms)
          <input
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            type="number"
            min={100}
            max={120000}
            value={timeoutMs}
            disabled={!overrideTimeout}
            onChange={(event) => setTimeoutMs(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-pf-deep">
          <input
            type="checkbox"
            checked={overrideMaxAttempts}
            onChange={(event) => setOverrideMaxAttempts(event.target.checked)}
          />
          Use venue-specific attempts
        </label>
        <label className="text-xs font-medium text-pf-deep sm:col-span-2">
          Maximum output tokens
          <select
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            value={maxOutputTokensMode}
            onChange={(event) =>
              setMaxOutputTokensMode(event.target.value as 'inherit' | 'limit' | 'unbounded')
            }
          >
            <option value="inherit">Inherit</option>
            <option value="limit">Set venue limit</option>
            <option value="unbounded">No limit</option>
          </select>
          <input
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            type="number"
            min={1}
            max={32000}
            value={maxOutputTokens}
            disabled={maxOutputTokensMode !== 'limit'}
            onChange={(event) => setMaxOutputTokens(event.target.value)}
          />
        </label>
        <label className="text-xs font-medium text-pf-deep">
          Maximum attempts
          <input
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            type="number"
            min={1}
            max={5}
            value={maxAttempts}
            disabled={!overrideMaxAttempts}
            onChange={(event) => setMaxAttempts(event.target.value)}
          />
        </label>
        <label className="text-xs font-medium text-pf-deep sm:col-span-2">
          Per-request budget ceiling (10^-8 USD units)
          <select
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            value={budgetMode}
            onChange={(event) =>
              setBudgetMode(event.target.value as 'inherit' | 'limit' | 'unbounded')
            }
          >
            <option value="inherit">Inherit</option>
            <option value="limit">Set venue ceiling</option>
            <option value="unbounded">No ceiling</option>
          </select>
          <input
            className="mt-1 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            inputMode="numeric"
            pattern="[0-9]*"
            value={budget}
            disabled={budgetMode !== 'limit'}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label className="text-xs font-medium text-pf-deep sm:col-span-2">
          Reason (required; retained in immutable history)
          <textarea
            className="mt-1 min-h-20 w-full rounded-lg border border-pf-light bg-white px-3 py-2 text-sm"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label className="flex items-start gap-2 text-xs text-amber-950 sm:col-span-2">
          <input
            type="checkbox"
            checked={unsafe}
            onChange={(event) => setUnsafe(event.target.checked)}
          />
          Explicitly approve spend-expanding/model-selection changes. Leave off for ordinary,
          non-expanding staged edits.
        </label>
      </div>
      {hasUnavailableSelectedRoute ? (
        <p className="mt-3 text-xs text-amber-800">
          This route cannot be saved because its provider is unavailable to this admin control. The
          visitor-chat runtime is verified separately.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            busy ||
            reason.trim().length === 0 ||
            hasUnavailableSelectedRoute ||
            hasIncompleteOverride
          }
          onClick={() => void save()}
          className="rounded-lg bg-pf-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save staged override'}
        </button>
        {current && !current.isTombstone ? (
          <button
            type="button"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void reset()}
            className="rounded-lg border border-pf-light bg-white px-4 py-2 text-sm font-semibold text-pf-deep disabled:opacity-50"
          >
            Reset to inherited
          </button>
        ) : null}
      </div>
      {status ? (
        <p role="status" className="mt-3 text-xs text-pf-deep">
          {status}
        </p>
      ) : null}
    </details>
  )
}

export function AiWorkloadConfigurationView({ data }: { data: Data }) {
  return (
    <section className="space-y-6" aria-labelledby="ai-workload-heading">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Staged control plane
        </p>
        <h2 id="ai-workload-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          AI workloads
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Inspect effective settings and their source, then deliberately stage venue overrides.
          Saving here never calls a provider and never bypasses the runtime budget gate.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Configuration layers">
        {data.layers.map((layer) => (
          <div
            key={layer.level}
            className="rounded-2xl border border-pf-light bg-pf-surface/60 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-pf-deep">{layer.level.toLowerCase()}</h3>
              <span className="rounded-full bg-emerald-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-emerald-800">
                {layer.availability.toLowerCase()}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-pf-deep/75">{layer.detail}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>Budget boundary remains separate.</strong> {data.budgetIntegration.detail}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {data.workloads.map((workload) => (
          <article
            key={workload.workloadId}
            className="rounded-2xl border border-pf-light bg-white p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-pf-deep">{workload.workloadId}</h3>
                <p className="mt-1 text-xs uppercase tracking-wider text-pf-deep/75">
                  {workload.kind.toLowerCase()} · model source{' '}
                  {workload.effective.sources.primaryModelKey.toLowerCase()}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  workload.overrides.venue?.enabled
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-100 text-slate-700'
                }`}
              >
                {workload.overrides.venue?.enabled ? 'Venue override enabled' : 'Inherited'}
              </span>
            </div>

            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Provider / model</dt>
                <dd className="mt-1 break-words font-medium text-pf-deep">
                  {workload.provider} / {workload.model}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Fallback</dt>
                <dd className="mt-1 font-medium text-pf-deep">
                  {workload.effective.fallback.enabled
                    ? workload.effective.fallback.modelKeys.join(', ')
                    : 'Disabled'}{' '}
                  <span className="block text-xs text-pf-deep/60">
                    source {workload.effective.sources.fallback.toLowerCase()}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Request budget ceiling</dt>
                <dd className="mt-1 font-medium text-pf-deep">
                  {workload.effective.requestBudgetCeilingE8Usd ?? 'Not configured'}{' '}
                  <span className="block text-xs text-pf-deep/60">
                    source {workload.effective.sources.requestBudgetCeilingE8Usd.toLowerCase()}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Effective limits</dt>
                <dd className="mt-1 font-medium text-pf-deep">
                  {workload.effective.maxAttempts} attempt
                  {workload.effective.maxAttempts === 1 ? '' : 's'} ·{' '}
                  {workload.effective.timeoutMs.toLocaleString()} ms
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-pf-deep/75">Configured cost estimate</dt>
                <dd className="mt-1 text-pf-deep">
                  Input {formatRate(workload.pricingEstimate.usdPerMillionTokens.input)} / 1M tokens
                  <span className="mt-1 block text-xs text-pf-deep/75">
                    {workload.pricingEstimate.version} · estimate, not an invoice
                  </span>
                </dd>
              </div>
            </dl>
            <div
              className="mt-4 grid gap-2 sm:grid-cols-3"
              aria-label={`${workload.workloadId} override layers`}
            >
              {(['workload', 'client', 'venue'] as const).map((level) => {
                const override = workload.overrides[level]
                return (
                  <div
                    key={level}
                    className="rounded-lg border border-pf-light px-3 py-2 text-xs text-pf-deep"
                  >
                    <strong className="capitalize">{level}</strong>
                    <span className="mt-1 block text-pf-deep/70">
                      {!override
                        ? 'Inherited · no row'
                        : override.isTombstone
                          ? `Reset tombstone · r${override.revision}`
                          : `${override.enabled ? 'Enabled' : 'Staged off'} · r${override.revision}`}
                    </span>
                  </div>
                )
              })}
            </div>
            <VenueOverrideEditor workload={workload} scope={data.scope} />
          </article>
        ))}
      </div>
    </section>
  )
}
