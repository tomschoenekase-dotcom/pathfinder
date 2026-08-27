import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type Readiness = inferRouterOutputs<AppRouter>['admin']['operationsReadiness']

function state(ready: boolean) {
  return ready
    ? { label: 'Ready', tone: 'border-emerald-200 bg-emerald-50 text-emerald-900' }
    : { label: 'Needs attention', tone: 'border-rose-200 bg-rose-50 text-rose-900' }
}

function duration(value: number | null) {
  if (value === null) return 'Not observed'
  if (value < 1_000) return `${value.toLocaleString('en-US')} ms`
  return `${(value / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`
}

function estimatedCost(value: string) {
  const [whole = '0', fraction = ''] = value.split('.')
  const displayedFraction = fraction.replace(/0+$/u, '').padEnd(2, '0')
  return `$${BigInt(whole).toLocaleString('en-US')}.${displayedFraction}`
}

export function OperationsReadinessSummary({ readiness }: { readiness: Readiness }) {
  const requirements = [
    [
      'Data and migrations',
      readiness.requirements.databaseConnected &&
        readiness.requirements.redisConnected &&
        readiness.requirements.migrationParity,
    ],
    ['Worker heartbeat', readiness.requirements.workerHeartbeatFresh],
    ['Schedulers', readiness.requirements.schedulersEnabled],
    ['Provider work', readiness.requirements.providerWorkEnabled],
    ['Queue observation', readiness.requirements.allQueuesObserved],
    ['Queue flow', readiness.requirements.noQueuesPaused],
    ['Long-running work', readiness.requirements.noStuckCriticalJobs],
    ['Intake verification', readiness.requirements.intakeVerificationEnabled],
    ['Object storage', readiness.requirements.objectStorageConnected],
    ['Malware scanner', readiness.requirements.malwareScannerConnected],
  ] as const

  return (
    <section
      aria-labelledby="operations-readiness-heading"
      className={`rounded-2xl border p-4 sm:p-5 ${
        readiness.status === 'ready'
          ? 'border-emerald-200 bg-emerald-50/70'
          : 'border-rose-200 bg-rose-50/70'
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-600">
            Service readiness
          </p>
          <h2
            id="operations-readiness-heading"
            className="mt-1 text-lg font-semibold text-slate-950"
          >
            {readiness.status === 'ready'
              ? 'Core operations are ready'
              : 'Core operations need attention'}
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            Exact migration, worker, scheduler, live queue, storage, and malware-scanner evidence. A
            green public health probe alone is not treated as proof that background or provider work
            can run.
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-bold uppercase ${
            readiness.status === 'ready'
              ? 'bg-emerald-100 text-emerald-900'
              : 'bg-rose-100 text-rose-900'
          }`}
        >
          {readiness.status}
        </span>
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {requirements.map(([label, ready]) => {
          const display = state(ready)
          return (
            <li key={label} className={`rounded-xl border p-3 ${display.tone}`}>
              <p className="text-xs font-semibold">{label}</p>
              <p className="mt-1 text-sm font-bold">{display.label}</p>
            </li>
          )
        })}
      </ul>

      <dl className="mt-4 grid gap-2 text-xs text-slate-700 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="font-semibold text-slate-600">Worker revision</dt>
          <dd className="mt-0.5 break-all">{readiness.worker.revision ?? 'Not observed'}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Paused queues</dt>
          <dd className="mt-0.5">
            {readiness.queue.live.status === 'observed'
              ? readiness.queue.live.pausedQueues
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Long-running jobs</dt>
          <dd className="mt-0.5">{readiness.stuckCriticalJobs}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Dependency evidence</dt>
          <dd className="mt-0.5">
            {readiness.serviceDependencies.state === 'FRESH'
              ? 'Fresh worker observation'
              : readiness.serviceDependencies.state.replaceAll('_', ' ').toLowerCase()}
          </dd>
        </div>
      </dl>

      <div className="mt-5 border-t border-slate-300/70 pt-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-950">Last-hour worker performance</h3>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Privacy-safe throughput, processing, queue, provider-wait, retry, and estimated-cost
              observations.
            </p>
          </div>
          <p className="text-xs font-semibold text-slate-600">
            {readiness.performance.complete ? 'Complete bounded window' : 'Partial capped window'}
          </p>
        </div>

        <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Terminal jobs / 60 min</dt>
            <dd className="mt-1 text-lg font-bold text-slate-950">
              {readiness.performance.jobs.terminal.toLocaleString('en-US')}
            </dd>
            <dd className="text-xs text-slate-600">
              {readiness.performance.jobs.completed.toLocaleString('en-US')} complete ·{' '}
              {readiness.performance.jobs.failed.toLocaleString('en-US')} failed
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Processing time</dt>
            <dd className="mt-1 text-sm font-bold text-slate-950">
              p50 {duration(readiness.performance.jobs.processingMs.p50)}
            </dd>
            <dd className="text-xs text-slate-600">
              p95 {duration(readiness.performance.jobs.processingMs.p95)}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Live queue</dt>
            <dd className="mt-1 text-sm font-bold text-slate-950">
              {readiness.queue.live.status === 'observed'
                ? `${readiness.queue.live.totalDepth.toLocaleString('en-US')} queued`
                : 'Unavailable'}
            </dd>
            <dd className="text-xs text-slate-600">
              Oldest{' '}
              {readiness.queue.live.status === 'observed'
                ? duration(readiness.queue.live.oldestAgeMs)
                : 'not observed'}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Job retry attempts</dt>
            <dd className="mt-1 text-lg font-bold text-slate-950">
              {readiness.performance.jobs.retryAttempts.toLocaleString('en-US')}
            </dd>
            <dd className="text-xs text-slate-600">Beyond each job&apos;s first attempt</dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Provider requests</dt>
            <dd className="mt-1 text-lg font-bold text-slate-950">
              {readiness.performance.provider.requests.toLocaleString('en-US')}
            </dd>
            <dd className="text-xs text-slate-600">
              {readiness.performance.provider.failed.toLocaleString('en-US')} failed ·{' '}
              {readiness.performance.provider.retryAttempts.toLocaleString('en-US')} retries
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Provider wait</dt>
            <dd className="mt-1 text-sm font-bold text-slate-950">
              p50 {duration(readiness.performance.provider.latencyMs.p50)}
            </dd>
            <dd className="text-xs text-slate-600">
              p95 {duration(readiness.performance.provider.latencyMs.p95)}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Estimated provider cost</dt>
            <dd className="mt-1 text-lg font-bold text-slate-950">
              {estimatedCost(readiness.performance.provider.estimatedCostUsd)}
            </dd>
            <dd className="text-xs text-slate-600">Operational estimate, not invoice truth</dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
            <dt className="text-xs font-semibold text-slate-600">Retained queue failures</dt>
            <dd className="mt-1 text-lg font-bold text-slate-950">
              {readiness.queue.live.status === 'observed'
                ? readiness.queue.live.totalFailed.toLocaleString('en-US')
                : '—'}
            </dd>
            <dd className="text-xs text-slate-600">Not automatically a current incident</dd>
          </div>
        </dl>
      </div>

      <p className="mt-4 text-xs leading-5 text-slate-600">
        Storage and malware state comes from bounded, read-only worker probes and expires after 90
        seconds. This view does not prove AI-provider execution, email delivery, an SLO, or external
        alert delivery. Those remain separate evidence gates.
      </p>
    </section>
  )
}
