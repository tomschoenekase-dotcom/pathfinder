import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type Readiness = inferRouterOutputs<AppRouter>['admin']['operationsReadiness']

function state(ready: boolean) {
  return ready
    ? { label: 'Ready', tone: 'border-emerald-200 bg-emerald-50 text-emerald-900' }
    : { label: 'Needs attention', tone: 'border-rose-200 bg-rose-50 text-rose-900' }
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
            Exact migration, worker, scheduler, and live queue evidence. A green public health probe
            alone is not treated as proof that background or provider work can run.
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

      <dl className="mt-4 grid gap-2 text-xs text-slate-700 sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-slate-500">Worker revision</dt>
          <dd className="mt-0.5 break-all">{readiness.worker.revision ?? 'Not observed'}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500">Paused queues</dt>
          <dd className="mt-0.5">
            {readiness.queue.live.status === 'observed'
              ? readiness.queue.live.pausedQueues
              : 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-500">Long-running jobs</dt>
          <dd className="mt-0.5">{readiness.stuckCriticalJobs}</dd>
        </div>
      </dl>

      <p className="mt-4 text-xs leading-5 text-slate-600">
        This view does not prove provider execution, object-storage or malware-scanner connectivity,
        email delivery, an SLO, or external alert delivery. Those remain separate evidence gates.
      </p>
    </section>
  )
}
