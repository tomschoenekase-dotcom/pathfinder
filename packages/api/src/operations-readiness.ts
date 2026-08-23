import {
  checkDatabaseConnection,
  readOperationalHealth,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { checkBullMQConnection, inspectQueueOperationalSnapshot } from '@pathfinder/jobs'

const PROBE_TIMEOUT_MS = 1_500

type PersistedOperationalHealth = Awaited<ReturnType<typeof readOperationalHealth>>
type QueueOperationalSnapshot = Awaited<ReturnType<typeof inspectQueueOperationalSnapshot>>
type Observation<T> =
  | { status: 'observed'; value: T }
  | { status: 'unavailable'; reason: 'probe-failed' | 'probe-timeout' }

async function boundedProbe(probe: (timeoutMs: number) => Promise<unknown>) {
  try {
    await probe(PROBE_TIMEOUT_MS)
    return 'up' as const
  } catch {
    return 'down' as const
  }
}

async function boundedObservation<T>(operation: () => Promise<T>): Promise<Observation<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Observation<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'unavailable', reason: 'probe-timeout' }),
      PROBE_TIMEOUT_MS,
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value): Observation<T> => ({ status: 'observed', value }),
          (): Observation<T> => ({ status: 'unavailable', reason: 'probe-failed' }),
        ),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function projectOperationsReadiness(input: {
  database: 'up' | 'down'
  redis: 'up' | 'down'
  persisted: PersistedOperationalHealth
  liveQueue: Observation<QueueOperationalSnapshot>
}) {
  const { queue: persistedQueue, ...persisted } = input.persisted
  const liveQueueComplete =
    input.liveQueue.status === 'observed' && input.liveQueue.value.coverage.complete
  return {
    schemaVersion: 'pathfinder.operations-readiness.v2',
    status:
      input.database === 'up' &&
      input.redis === 'up' &&
      persisted.migration.parity &&
      persisted.worker.fresh &&
      liveQueueComplete
        ? ('ready' as const)
        : ('degraded' as const),
    probes: { database: input.database, redis: input.redis },
    ...persisted,
    queue: {
      persisted: persistedQueue,
      live:
        input.liveQueue.status === 'observed'
          ? {
              status: 'observed' as const,
              source: 'bullmq-redis' as const,
              ...input.liveQueue.value,
            }
          : {
              status: 'unavailable' as const,
              source: 'bullmq-redis' as const,
              reason: input.liveQueue.reason,
            },
    },
    boundaries: {
      liveQueueIsPlatformWide: true,
      tenantOrVenueQueueAttributionAvailable: false,
      jobIdentityIncluded: false,
      payloadOrFailureDetailIncluded: false,
      retainedFailedCountIsCurrentIncident: false,
      providerExecutionProven: false,
      retryAuthorized: false,
      cancellationAuthorized: false,
      redriveAuthorized: false,
      incidentControlAuthorized: false,
      serviceLevelObjectivePolicy: 'UNRESOLVED' as const,
    },
  }
}

export async function readOperationsReadiness(
  dependencies: {
    checkDatabase?: typeof checkDatabaseConnection
    checkRedis?: typeof checkBullMQConnection
    readPersisted?: typeof readOperationalHealth
    inspectQueue?: () => Promise<QueueOperationalSnapshot>
    bypass?: typeof withTenantIsolationBypass
  } = {},
) {
  const bypass = dependencies.bypass ?? withTenantIsolationBypass
  return bypass(async () => {
    const [database, redis, persisted, liveQueue] = await Promise.all([
      boundedProbe(dependencies.checkDatabase ?? checkDatabaseConnection),
      boundedProbe(dependencies.checkRedis ?? checkBullMQConnection),
      (dependencies.readPersisted ?? readOperationalHealth)(),
      boundedObservation(dependencies.inspectQueue ?? (() => inspectQueueOperationalSnapshot())),
    ])
    return projectOperationsReadiness({ database, redis, persisted, liveQueue })
  })
}
