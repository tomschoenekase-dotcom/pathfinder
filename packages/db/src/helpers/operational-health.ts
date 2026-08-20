import { db } from '../client'

export const EXPECTED_LATEST_MIGRATION = '20260819156000_add_operational_event_delivery_audit'
export const WORKER_HEARTBEAT_KEY = 'operations.worker-heartbeat.v1'

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
  const staleJobCutoff = new Date(now.getTime() - 15 * 60 * 1000)
  const [migration, worker, jobs, ai, embedding, email, malware] = await Promise.all([
    readAppliedMigrationStatus(),
    db.platformConfig.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } }),
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
    worker: worker ? { value: worker.value, updatedAt: worker.updatedAt } : null,
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
