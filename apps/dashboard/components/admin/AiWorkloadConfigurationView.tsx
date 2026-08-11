type Workload = {
  workloadId: string
  kind: 'TEXT' | 'EMBEDDING'
  provider: string
  model: string
  effectiveSource: 'PLATFORM' | 'WORKLOAD' | 'CLIENT' | 'VENUE'
  fallback: { enabled: boolean; modelKeys: string[] }
  requestBudgetCeilingE8Usd: string | null
  pricingEstimate: {
    version: string
    usdPerMillionTokens: { input: number; output?: number; cacheWrite?: number; cacheRead?: number }
    invoiceAmount: false
  }
  limits: {
    timeoutMs: number
    maxAttempts: number
    maxInputUtf8Bytes: number
    maxBillableInputTokens: number
    maxOutputTokens?: number
    dimensions?: number
  }
  unsafeChangesEnabled: false
}

type Props = {
  data: {
    readOnly: true
    scope: { tenantId: string; venueId: string }
    layers: Array<{
      level: 'PLATFORM' | 'WORKLOAD' | 'CLIENT' | 'VENUE'
      availability: 'AVAILABLE' | 'UNAVAILABLE'
      detail: string
    }>
    budgetIntegration: { availability: 'UNAVAILABLE'; detail: string }
    workloads: Workload[]
  }
}

function formatRate(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
}

export function AiWorkloadConfigurationView({ data }: Props) {
  return (
    <section className="space-y-6" aria-labelledby="ai-workload-heading">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Read-only configuration
        </p>
        <h2 id="ai-workload-heading" className="mt-2 text-2xl font-semibold text-pf-deep">
          AI workloads
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Effective registry settings for this venue. This view cannot change models, enable
          fallback, or alter spend controls.
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
              <span
                className={`rounded-full px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wider ${
                  layer.availability === 'AVAILABLE'
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-200 text-slate-700'
                }`}
              >
                {layer.availability.toLowerCase()}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-pf-deep/75">{layer.detail}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>Scoped workload budget unavailable.</strong> {data.budgetIntegration.detail}
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
                  {workload.kind.toLowerCase()} · source {workload.effectiveSource.toLowerCase()}
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                Unsafe changes off
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
                  {workload.fallback.enabled ? workload.fallback.modelKeys.join(', ') : 'Disabled'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Request budget ceiling</dt>
                <dd className="mt-1 font-medium text-pf-deep">
                  {workload.requestBudgetCeilingE8Usd ?? 'Not configured'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-pf-deep/75">Configured limits</dt>
                <dd className="mt-1 font-medium text-pf-deep">
                  {workload.limits.maxAttempts} attempt
                  {workload.limits.maxAttempts === 1 ? '' : 's'} ·{' '}
                  {workload.limits.timeoutMs.toLocaleString()} ms
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-pf-deep/75">Cost estimate configuration</dt>
                <dd className="mt-1 text-pf-deep">
                  Input {formatRate(workload.pricingEstimate.usdPerMillionTokens.input)} / 1M tokens
                  {workload.pricingEstimate.usdPerMillionTokens.output === undefined
                    ? ''
                    : ` · output ${formatRate(workload.pricingEstimate.usdPerMillionTokens.output)} / 1M tokens`}
                  <span className="mt-1 block text-xs text-pf-deep/75">
                    {workload.pricingEstimate.version} · estimate, not an invoice
                  </span>
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  )
}
