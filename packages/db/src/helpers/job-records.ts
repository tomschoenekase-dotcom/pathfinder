import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

export type WriteJobRecordParams = {
  queue: string
  jobName: string
  bullJobId?: string | null
  tenantId?: string | null
  status: 'RUNNING'
  payload?: Record<string, unknown>
  error?: string | null
  startedAt: Date
  completedAt?: Date | null
  attemptNumber?: number | null
  maxAttempts?: number | null
}

export type JobFailureDisposition = 'RETRY_ELIGIBLE' | 'ATTEMPTS_EXHAUSTED' | 'UNRECOVERABLE'

export type TerminalJobRecordEvidence = {
  id: string
  queue: string
  jobName: string
  bullJobId: string | null
  tenantId: string | null
  payload: unknown
  status: string
  attemptNumber: number | null
  maxAttempts: number | null
  failureDisposition: string | null
  terminalAt: Date | null
}

export async function findTerminalJobRecordEvidence(params: {
  queue: string
  bullJobId: string
}): Promise<TerminalJobRecordEvidence | null> {
  return withTenantIsolationBypass(() =>
    db.jobRecord.findUnique({
      where: {
        queue_bullJobId: {
          queue: params.queue,
          bullJobId: params.bullJobId,
        },
      },
      select: {
        id: true,
        queue: true,
        jobName: true,
        bullJobId: true,
        tenantId: true,
        payload: true,
        status: true,
        attemptNumber: true,
        maxAttempts: true,
        failureDisposition: true,
        terminalAt: true,
      },
    }),
  )
}

export async function findTerminalJobRecordEvidenceById(
  id: string,
): Promise<TerminalJobRecordEvidence | null> {
  return withTenantIsolationBypass(() =>
    db.jobRecord.findUnique({
      where: { id },
      select: {
        id: true,
        queue: true,
        jobName: true,
        bullJobId: true,
        tenantId: true,
        payload: true,
        status: true,
        attemptNumber: true,
        maxAttempts: true,
        failureDisposition: true,
        terminalAt: true,
      },
    }),
  )
}

export async function writeJobRecord(params: WriteJobRecordParams): Promise<string> {
  const payload = params.payload ?? {}
  const payloadVenueId = payload.venueId
  const venueId =
    typeof payloadVenueId === 'string' && payloadVenueId.trim().length > 0
      ? payloadVenueId.trim()
      : null
  const data = {
    queue: params.queue,
    jobName: params.jobName,
    bullJobId: params.bullJobId ?? null,
    tenantId: params.tenantId ?? null,
    venueId,
    status: params.status,
    payload,
    error: params.error ?? null,
    startedAt: params.startedAt,
    completedAt: params.completedAt ?? null,
    attemptNumber: params.attemptNumber ?? null,
    maxAttempts: params.maxAttempts ?? null,
    failureDisposition: null,
    terminalAt: null,
  }

  // BullMQ reuses an id across retries, but ids are unique only within a queue. Upsert
  // on the composite queue/id identity so retries update their record without allowing
  // an unrelated queue that chose the same id to overwrite it. The legacy global unique
  // index remains temporarily for rolling-deploy compatibility and fails cross-queue ID
  // reuse closed until a separately gated contract migration removes it.
  if (params.bullJobId) {
    const record = await withTenantIsolationBypass(() =>
      db.jobRecord.upsert({
        where: {
          queue_bullJobId: {
            queue: params.queue,
            bullJobId: params.bullJobId as string,
          },
        },
        create: data,
        update: data,
        select: { id: true },
      }),
    )

    return record.id
  }

  const record = await withTenantIsolationBypass(() =>
    db.jobRecord.create({
      data,
      select: { id: true },
    }),
  )

  return record.id
}

export async function updateJobRecord(
  id: string,
  data:
    | { status: 'COMPLETE'; completedAt?: Date }
    | {
        status: 'FAILED'
        error: string
        attemptNumber: number
        maxAttempts: number
        failureDisposition: JobFailureDisposition
        completedAt?: Date
      },
): Promise<void> {
  const completedAt = data.completedAt ?? new Date()
  await withTenantIsolationBypass(() =>
    db.jobRecord.update({
      where: { id },
      data:
        data.status === 'FAILED'
          ? {
              status: data.status,
              error: data.error,
              attemptNumber: data.attemptNumber,
              maxAttempts: data.maxAttempts,
              failureDisposition: data.failureDisposition,
              terminalAt: data.failureDisposition === 'RETRY_ELIGIBLE' ? null : completedAt,
              completedAt,
            }
          : {
              status: data.status,
              error: null,
              failureDisposition: null,
              terminalAt: null,
              completedAt,
            },
    }),
  )
}
