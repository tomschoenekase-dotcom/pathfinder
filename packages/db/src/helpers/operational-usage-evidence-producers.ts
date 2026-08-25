import { createHash } from 'node:crypto'

import type { inspectDeclaredOperationalUsage } from './declared-operational-usage'
import {
  recordOperationalUsageEvidenceAction,
  type RecordOperationalUsageEvidenceInput,
} from './operational-usage-evidence-actions'

type RecordUsage = (
  input: RecordOperationalUsageEvidenceInput,
) => ReturnType<typeof recordOperationalUsageEvidenceAction>

export type QueueOperationalUsageSnapshot = {
  observedAt: Date
  coverage: { expectedQueues: number; observedQueues: number; complete: boolean }
  totalDepth: number
  totalFailed: number
  pausedQueues: number
  jobSchedulers: number
  oldestAgeMs: number | null
  queues: Array<{
    name: string
    counts: unknown
    depth: number
    failed: number
    paused: boolean
    jobSchedulers: number
    oldestQueuedAt: Date | null
    oldestAgeMs: number | null
  }>
}

type DeclaredUsageSnapshot = Awaited<ReturnType<typeof inspectDeclaredOperationalUsage>>

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function snapshotIdentity(snapshot: QueueOperationalUsageSnapshot) {
  return JSON.stringify({
    observedAt: snapshot.observedAt.toISOString(),
    coverage: snapshot.coverage,
    totalDepth: snapshot.totalDepth,
    totalFailed: snapshot.totalFailed,
    pausedQueues: snapshot.pausedQueues,
    jobSchedulers: snapshot.jobSchedulers,
    oldestAgeMs: snapshot.oldestAgeMs,
    queues: snapshot.queues.map((queue) => ({
      name: queue.name,
      counts: queue.counts,
      depth: queue.depth,
      failed: queue.failed,
      paused: queue.paused,
      jobSchedulers: queue.jobSchedulers,
      oldestQueuedAt: queue.oldestQueuedAt?.toISOString() ?? null,
      oldestAgeMs: queue.oldestAgeMs,
    })),
  })
}

/** Retains queue gauges without assigning price, SLO, anomaly, or cutoff policy. */
export async function recordQueueOperationalUsageSnapshot(
  snapshot: QueueOperationalUsageSnapshot,
  record: RecordUsage = recordOperationalUsageEvidenceAction,
) {
  if (
    !snapshot.coverage.complete ||
    snapshot.coverage.expectedQueues !== snapshot.coverage.observedQueues
  ) {
    throw new Error('Queue usage evidence requires complete canonical queue coverage.')
  }

  const sourceDigest = sha256(snapshotIdentity(snapshot))
  const sourceReference = `queue-snapshot:${snapshot.observedAt.toISOString()}`
  const actor = {
    type: 'SYSTEM' as const,
    id: 'worker:operational-usage',
    role: 'SYSTEM' as const,
  }
  const observations = [
    {
      metric: 'QUEUE_DEPTH' as const,
      quantity: String(snapshot.totalDepth),
      unit: 'JOBS' as const,
    },
    {
      metric: 'QUEUE_FAILED_JOBS' as const,
      quantity: String(snapshot.totalFailed),
      unit: 'JOBS' as const,
    },
    ...(snapshot.oldestAgeMs === null
      ? []
      : [
          {
            metric: 'QUEUE_OLDEST_AGE_MILLISECONDS' as const,
            quantity: String(snapshot.oldestAgeMs),
            unit: 'MILLISECONDS' as const,
          },
        ]),
  ]

  const results = []
  for (const observation of observations) {
    results.push(
      await record({
        operationId: deterministicUuid(`${sourceDigest}:${observation.metric}`),
        metric: observation.metric,
        measurementKind: 'GAUGE',
        quantity: observation.quantity,
        unit: observation.unit,
        observedAt: snapshot.observedAt,
        sourceSystem: 'bullmq-operational-snapshot',
        sourceReference: `${sourceReference}:${observation.metric.toLowerCase()}`,
        sourceDigest,
        actor,
      }),
    )
  }

  return {
    observedAt: snapshot.observedAt,
    sourceDigest,
    metricsRecorded: results.length,
    completeQueueCoverage: true as const,
  }
}

/** Retains daily database-declared bytes; it does not claim provider inventory or cost. */
export async function recordDeclaredOperationalUsageSnapshot(
  snapshot: DeclaredUsageSnapshot,
  record: RecordUsage = recordOperationalUsageEvidenceAction,
) {
  const dailyObservedAt = new Date(
    Date.UTC(
      snapshot.observedAt.getUTCFullYear(),
      snapshot.observedAt.getUTCMonth(),
      snapshot.observedAt.getUTCDate(),
    ),
  )
  let metricsRecorded = 0
  for (const scope of snapshot.scopes) {
    const identity = JSON.stringify({
      day: dailyObservedAt.toISOString(),
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      intakeDeclaredBytes: String(scope.intakeDeclaredBytes),
      mediaDeclaredBytes: String(scope.mediaDeclaredBytes),
      limitations: snapshot.limitations,
    })
    const sourceDigest = sha256(identity)
    const scopeDigest = sha256(`${scope.tenantId}:${scope.venueId}`).slice(0, 24)
    const observations = [
      { metric: 'INTAKE_DECLARED_BYTES' as const, quantity: String(scope.intakeDeclaredBytes) },
      { metric: 'MEDIA_DECLARED_BYTES' as const, quantity: String(scope.mediaDeclaredBytes) },
    ]
    for (const observation of observations) {
      await record({
        operationId: deterministicUuid(`${sourceDigest}:${observation.metric}`),
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        metric: observation.metric,
        measurementKind: 'GAUGE',
        quantity: observation.quantity,
        unit: 'BYTES',
        observedAt: dailyObservedAt,
        sourceSystem: 'torchiko-database-declared-usage',
        sourceReference: `daily:${dailyObservedAt.toISOString().slice(0, 10)}:${scopeDigest}:${observation.metric.toLowerCase()}`,
        sourceDigest,
        actor: { type: 'SYSTEM', id: 'worker:operational-usage', role: 'SYSTEM' },
      })
      metricsRecorded += 1
    }
  }
  return {
    observedAt: dailyObservedAt,
    scopesRecorded: snapshot.scopes.length,
    metricsRecorded,
    dollarCostAssigned: false as const,
    providerInventoryObserved: false as const,
  }
}
