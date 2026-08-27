import { db } from '../client'

export const EXPECTED_LATEST_MIGRATION = '20260826010000_add_governed_venue_media'
export const WORKER_HEARTBEAT_KEY = 'operations.worker-heartbeat.v1'
export const WORKER_HEARTBEAT_FRESHNESS_MS = 90_000
export const SERVICE_DEPENDENCY_OBSERVATION_KEY = 'operations.service-dependencies.v1'
export const SERVICE_DEPENDENCY_FRESHNESS_MS = 90_000
export const OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS = 15 * 60 * 1000

type WorkerHeartbeatRecord = { value: unknown; updatedAt: Date } | null
type ServiceDependencyRecord = { value: unknown; updatedAt: Date } | null
export type ServiceDependencyStatus = 'up' | 'down' | 'unconfigured'

/**
 * Secret-free, fail-closed projection shared by the administrator readiness route and bounded
 * agent reads. PlatformConfig is schemaless, so malformed or stale evidence must never be
 * interpreted as a live worker.
 */
export function projectWorkerHeartbeat(record: WorkerHeartbeatRecord, now = new Date()) {
  const value = record?.value
  if (!record) {
    return {
      source: 'persisted-platform-config' as const,
      state: 'NOT_OBSERVED' as const,
      fresh: false,
      staleAfterMs: WORKER_HEARTBEAT_FRESHNESS_MS,
      observedAt: null,
      ageMs: null,
      mode: null,
      revision: null,
      schedulersEnabled: null,
      updatedAt: null,
    }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !('mode' in value) ||
    (value.mode !== 'provider-enabled' && value.mode !== 'provider-disabled') ||
    !('revision' in value) ||
    typeof value.revision !== 'string' ||
    value.revision.trim().length === 0 ||
    !('schedulersEnabled' in value) ||
    typeof value.schedulersEnabled !== 'boolean'
  ) {
    return {
      source: 'persisted-platform-config' as const,
      state: 'MALFORMED' as const,
      fresh: false,
      staleAfterMs: WORKER_HEARTBEAT_FRESHNESS_MS,
      observedAt: null,
      ageMs: null,
      mode: null,
      revision: null,
      schedulersEnabled: null,
      updatedAt: record.updatedAt,
    }
  }
  const observedAt = new Date(value.observedAt)
  const ageMs = Math.max(0, now.getTime() - observedAt.getTime())
  const fresh = ageMs <= WORKER_HEARTBEAT_FRESHNESS_MS
  return {
    source: 'persisted-platform-config' as const,
    state: fresh ? ('FRESH' as const) : ('STALE' as const),
    fresh,
    staleAfterMs: WORKER_HEARTBEAT_FRESHNESS_MS,
    observedAt,
    ageMs,
    mode: value.mode,
    revision: value.revision,
    schedulersEnabled: value.schedulersEnabled,
    updatedAt: record.updatedAt,
  }
}

export async function recordWorkerHeartbeat(input: {
  mode: 'provider-enabled' | 'provider-disabled'
  schedulersEnabled?: boolean
  revision?: string
  now?: Date
}) {
  const observedAt = (input.now ?? new Date()).toISOString()
  return db.platformConfig.upsert({
    where: { key: WORKER_HEARTBEAT_KEY },
    create: {
      key: WORKER_HEARTBEAT_KEY,
      value: {
        schemaVersion: 1,
        observedAt,
        mode: input.mode,
        revision: input.revision ?? 'unknown',
        schedulersEnabled: input.schedulersEnabled ?? false,
      },
      updatedBy: 'worker-runtime',
    },
    update: {
      value: {
        schemaVersion: 1,
        observedAt,
        mode: input.mode,
        revision: input.revision ?? 'unknown',
        schedulersEnabled: input.schedulersEnabled ?? false,
      },
      updatedBy: 'worker-runtime',
    },
  })
}

/**
 * Projects only bounded, secret-free evidence written by the worker runtime. A service probe is
 * useful only while it is fresh; old successes must never masquerade as current connectivity.
 */
export function projectServiceDependencyObservation(
  record: ServiceDependencyRecord,
  now = new Date(),
) {
  const unavailable = (state: 'NOT_OBSERVED' | 'MALFORMED', updatedAt: Date | null) => ({
    source: 'persisted-platform-config' as const,
    state,
    fresh: false,
    staleAfterMs: SERVICE_DEPENDENCY_FRESHNESS_MS,
    observedAt: null,
    ageMs: null,
    intakeVerificationRequired: null,
    objectStorage: 'unconfigured' as ServiceDependencyStatus,
    malwareScanner: 'unconfigured' as ServiceDependencyStatus,
    updatedAt,
  })
  if (!record) return unavailable('NOT_OBSERVED', null)
  const value = record.value
  const validStatus = (candidate: unknown): candidate is ServiceDependencyStatus =>
    candidate === 'up' || candidate === 'down' || candidate === 'unconfigured'
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !('intakeVerificationRequired' in value) ||
    typeof value.intakeVerificationRequired !== 'boolean' ||
    !('objectStorage' in value) ||
    !validStatus(value.objectStorage) ||
    !('malwareScanner' in value) ||
    !validStatus(value.malwareScanner)
  ) {
    return unavailable('MALFORMED', record.updatedAt)
  }
  const observedAt = new Date(value.observedAt)
  const ageMs = Math.max(0, now.getTime() - observedAt.getTime())
  const fresh = ageMs <= SERVICE_DEPENDENCY_FRESHNESS_MS
  return {
    source: 'persisted-platform-config' as const,
    state: fresh ? ('FRESH' as const) : ('STALE' as const),
    fresh,
    staleAfterMs: SERVICE_DEPENDENCY_FRESHNESS_MS,
    observedAt,
    ageMs,
    intakeVerificationRequired: value.intakeVerificationRequired,
    objectStorage: value.objectStorage,
    malwareScanner: value.malwareScanner,
    updatedAt: record.updatedAt,
  }
}

export async function recordServiceDependencyObservation(input: {
  intakeVerificationRequired: boolean
  objectStorage: ServiceDependencyStatus
  malwareScanner: ServiceDependencyStatus
  now?: Date
}) {
  const value = {
    schemaVersion: 1,
    observedAt: (input.now ?? new Date()).toISOString(),
    intakeVerificationRequired: input.intakeVerificationRequired,
    objectStorage: input.objectStorage,
    malwareScanner: input.malwareScanner,
  }
  return db.platformConfig.upsert({
    where: { key: SERVICE_DEPENDENCY_OBSERVATION_KEY },
    create: {
      key: SERVICE_DEPENDENCY_OBSERVATION_KEY,
      value,
      updatedBy: 'worker-runtime',
    },
    update: { value, updatedBy: 'worker-runtime' },
  })
}

export async function readAppliedMigrationStatus(client = db) {
  const rows = await client.$queryRaw<Array<{ migration_name: string; finished_at: Date }>>`
    SELECT migration_name, finished_at
      FROM _prisma_migrations
     WHERE finished_at IS NOT NULL
       AND rolled_back_at IS NULL
     ORDER BY finished_at DESC, migration_name DESC
     LIMIT 1
  `
  const latest = rows[0] ?? null
  return {
    expected: EXPECTED_LATEST_MIGRATION,
    applied: latest?.migration_name ?? null,
    appliedAt: latest?.finished_at ?? null,
    parity: latest?.migration_name === EXPECTED_LATEST_MIGRATION,
  }
}

export async function readOperationalHealth(now = new Date()) {
  const recentWindow = new Date(now.getTime() - 60 * 60 * 1000)
  const staleJobCutoff = new Date(now.getTime() - OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS)
  const [migration, worker, serviceDependencies, jobs, ai, embedding, email, malware] =
    await Promise.all([
      readAppliedMigrationStatus(),
      db.platformConfig.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } }),
      db.platformConfig.findUnique({ where: { key: SERVICE_DEPENDENCY_OBSERVATION_KEY } }),
      db.jobRecord.groupBy({
        by: ['status'],
        where: { createdAt: { gte: recentWindow } },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      db.aiUsageEvent.groupBy({
        by: ['success'],
        where: { createdAt: { gte: recentWindow } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      db.embeddingWorkClaim.groupBy({
        by: ['status'],
        where: { createdAt: { gte: recentWindow } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      db.jobRecord.findFirst({
        where: { queue: { contains: 'send-email' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { status: true, completedAt: true, createdAt: true, failureDisposition: true },
      }),
      db.intakeUploadVerificationReceipt.findFirst({
        where: { kind: 'MALWARE' },
        orderBy: { recordedAt: 'desc' },
        select: { verdict: true, engine: true, engineVersion: true, recordedAt: true },
      }),
    ])
  const stuckCriticalJobs = await db.jobRecord.count({
    where: { status: 'RUNNING', startedAt: { lt: staleJobCutoff } },
  })
  return {
    observedAt: now,
    migration,
    worker: projectWorkerHeartbeat(worker, now),
    serviceDependencies: projectServiceDependencyObservation(serviceDependencies, now),
    queue: { source: 'persisted-job-records', recentWindow, byStatus: jobs },
    scheduler: { status: 'reported-with-worker-heartbeat' },
    objectStorage: malware
      ? { status: 'recent-object-observed', lastVerifiedAt: malware.recordedAt }
      : { status: 'not-observed' },
    malwareScanning: malware,
    aiProviderOutcomes: ai,
    embeddingOutcomes: embedding,
    emailProviderOutcome: email,
    stuckCriticalJobs,
  }
}
