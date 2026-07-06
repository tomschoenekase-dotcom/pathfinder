import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

export type WriteJobRecordParams = {
  queue: string
  jobName: string
  bullJobId?: string | null
  tenantId?: string | null
  status: 'RUNNING' | 'COMPLETE' | 'FAILED'
  payload?: Record<string, unknown>
  error?: string | null
  startedAt: Date
  completedAt?: Date | null
}

export async function writeJobRecord(params: WriteJobRecordParams): Promise<string> {
  const data = {
    queue: params.queue,
    jobName: params.jobName,
    bullJobId: params.bullJobId ?? null,
    tenantId: params.tenantId ?? null,
    status: params.status,
    payload: params.payload ?? {},
    error: params.error ?? null,
    startedAt: params.startedAt,
    completedAt: params.completedAt ?? null,
  }

  // BullMQ reuses the same job id across retries of the same job. `bullJobId` is unique,
  // so a plain create() throws on the second attempt (constraint violation) before the
  // caller's own try/catch ever runs, leaving whatever status was set at the top of that
  // attempt stuck forever. Upsert on bullJobId so a retry updates the existing record
  // instead of colliding with it.
  if (params.bullJobId) {
    const record = await withTenantIsolationBypass(() =>
      db.jobRecord.upsert({
        where: { bullJobId: params.bullJobId as string },
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
  data: {
    status: 'COMPLETE' | 'FAILED'
    error?: string | null
    completedAt?: Date
  },
): Promise<void> {
  await withTenantIsolationBypass(() =>
    db.jobRecord.update({
      where: { id },
      data: {
        status: data.status,
        error: data.error ?? null,
        completedAt: data.completedAt ?? new Date(),
      },
    }),
  )
}
