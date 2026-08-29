import { sumAiCostDecimals } from '@pathfinder/ai'

import { db } from '../client'

export const EXPECTED_LATEST_MIGRATION = '20260829223000_add_file_clarification_resolutions'
export const WORKER_HEARTBEAT_KEY = 'operations.worker-heartbeat.v1'
export const WORKER_HEARTBEAT_FRESHNESS_MS = 90_000
export const SERVICE_DEPENDENCY_OBSERVATION_KEY = 'operations.service-dependencies.v1'
export const SERVICE_DEPENDENCY_FRESHNESS_MS = 90_000
export const OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS = 15 * 60 * 1000
export const OPERATIONAL_PERFORMANCE_WINDOW_MS = 60 * 60 * 1000
export const OPERATIONAL_PERFORMANCE_SAMPLE_LIMIT = 5_000

type WorkerHeartbeatRecord = { value: unknown; updatedAt: Date } | null
type ServiceDependencyRecord = { value: unknown; updatedAt: Date } | null
export type ServiceDependencyStatus = 'up' | 'down' | 'unconfigured'

type TerminalJobPerformanceRow = {
  status: string
  startedAt: Date
  completedAt: Date | null
  attemptNumber: number | null
}

type ProviderPerformanceRow = {
  latencyMs: number
  attempts: number
  estimatedCostUsd: unknown
  success: boolean
}

function percentile(values: number[], rank: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * rank) - 1] ?? null
}

/**
 * Projects a bounded, privacy-safe one-hour worker/provider performance window. These are
 * observations, never SLOs or pricing policy. A capped window is labeled partial rather than
 * silently treated as complete.
 */
export function projectOperationalPerformance(input: {
  observedAt: Date
  windowStartedAt: Date
  terminalJobs: TerminalJobPerformanceRow[]
  providerUsage: ProviderPerformanceRow[]
  sampleLimit?: number
}) {
  const sampleLimit = input.sampleLimit ?? OPERATIONAL_PERFORMANCE_SAMPLE_LIMIT
  const terminalJobs = input.terminalJobs.slice(0, sampleLimit)
  const providerUsage = input.providerUsage.slice(0, sampleLimit)
  const processingDurations = terminalJobs.flatMap((job) => {
    if (!job.completedAt) return []
    const duration = job.completedAt.getTime() - job.startedAt.getTime()
    return Number.isFinite(duration) && duration >= 0 ? [duration] : []
  })
  const providerLatencies = providerUsage.flatMap((usage) =>
    Number.isFinite(usage.latencyMs) && usage.latencyMs >= 0 ? [usage.latencyMs] : [],
  )

  return {
    source: 'persisted-job-and-ai-usage-records' as const,
    observedAt: input.observedAt,
    windowStartedAt: input.windowStartedAt,
    windowMs: Math.max(0, input.observedAt.getTime() - input.windowStartedAt.getTime()),
    complete: input.terminalJobs.length <= sampleLimit && input.providerUsage.length <= sampleLimit,
    sampleLimit,
    jobs: {
      terminal: terminalJobs.length,
      completed: terminalJobs.filter((job) => job.status === 'COMPLETE').length,
      failed: terminalJobs.filter((job) => job.status === 'FAILED').length,
      retryAttempts: terminalJobs.reduce(
        (total, job) => total + Math.max(0, (job.attemptNumber ?? 1) - 1),
        0,
      ),
      processingMs: {
        observed: processingDurations.length,
        p50: percentile(processingDurations, 0.5),
        p95: percentile(processingDurations, 0.95),
      },
    },
    provider: {
      requests: providerUsage.length,
      successful: providerUsage.filter((usage) => usage.success).length,
      failed: providerUsage.filter((usage) => !usage.success).length,
      retryAttempts: providerUsage.reduce(
        (total, usage) => total + Math.max(0, usage.attempts - 1),
        0,
      ),
      latencyMs: {
        observed: providerLatencies.length,
        p50: percentile(providerLatencies, 0.5),
        p95: percentile(providerLatencies, 0.95),
      },
      estimatedCostUsd: sumAiCostDecimals(providerUsage.map((usage) => usage.estimatedCostUsd)),
    },
    boundaries: {
      noPayloads: true,
      noJobIdentity: true,
      noProviderRequestIdentity: true,
      serviceLevelObjectivePolicy: 'UNRESOLVED' as const,
      estimatedCostIsInvoiceTruth: false,
    },
  }
}

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
  const recentWindow = new Date(now.getTime() - OPERATIONAL_PERFORMANCE_WINDOW_MS)
  const staleJobCutoff = new Date(now.getTime() - OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS)
  const [
    migration,
    worker,
    serviceDependencies,
    jobs,
    ai,
    embedding,
    email,
    malware,
    terminalJobs,
    providerUsage,
  ] = await Promise.all([
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
    db.jobRecord.findMany({
      where: {
        status: { in: ['COMPLETE', 'FAILED'] },
        completedAt: { gte: recentWindow },
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: OPERATIONAL_PERFORMANCE_SAMPLE_LIMIT + 1,
      select: { status: true, startedAt: true, completedAt: true, attemptNumber: true },
    }),
    db.aiUsageEvent.findMany({
      where: { createdAt: { gte: recentWindow } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: OPERATIONAL_PERFORMANCE_SAMPLE_LIMIT + 1,
      select: { latencyMs: true, attempts: true, estimatedCostUsd: true, success: true },
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
    performance: projectOperationalPerformance({
      observedAt: now,
      windowStartedAt: recentWindow,
      terminalJobs,
      providerUsage,
    }),
    stuckCriticalJobs,
  }
}
