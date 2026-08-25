import { checkDatabaseConnection, readOperationalHealth } from '@pathfinder/db'
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
  const dependencyEvidenceFresh = persisted.serviceDependencies.fresh
  const requirements = {
    databaseConnected: input.database === 'up',
    redisConnected: input.redis === 'up',
    migrationParity: persisted.migration.parity,
    workerHeartbeatFresh: persisted.worker.fresh,
    schedulersEnabled: persisted.worker.fresh && persisted.worker.schedulersEnabled === true,
    providerWorkEnabled: persisted.worker.fresh && persisted.worker.mode === 'provider-enabled',
    allQueuesObserved: liveQueueComplete,
    noQueuesPaused:
      input.liveQueue.status === 'observed' &&
      input.liveQueue.value.coverage.complete &&
      input.liveQueue.value.pausedQueues === 0,
    noStuckCriticalJobs: persisted.stuckCriticalJobs === 0,
    intakeVerificationEnabled:
      dependencyEvidenceFresh && persisted.serviceDependencies.intakeVerificationRequired === true,
    objectStorageConnected:
      dependencyEvidenceFresh && persisted.serviceDependencies.objectStorage === 'up',
    malwareScannerConnected:
      dependencyEvidenceFresh && persisted.serviceDependencies.malwareScanner === 'up',
  }
  return {
    schemaVersion: 'pathfinder.operations-readiness.v4',
    status: Object.values(requirements).every(Boolean) ? ('ready' as const) : ('degraded' as const),
    requirements,
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
      objectStorageConnectivityProven: requirements.objectStorageConnected,
      malwareScannerConnectivityProven: requirements.malwareScannerConnected,
      emailDeliveryProven: false,
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
  } = {},
) {
  const [database, redis, persisted, liveQueue] = await Promise.all([
    boundedProbe(dependencies.checkDatabase ?? checkDatabaseConnection),
    boundedProbe(dependencies.checkRedis ?? checkBullMQConnection),
    (dependencies.readPersisted ?? readOperationalHealth)(),
    boundedObservation(dependencies.inspectQueue ?? (() => inspectQueueOperationalSnapshot())),
  ])
  return projectOperationsReadiness({ database, redis, persisted, liveQueue })
}
