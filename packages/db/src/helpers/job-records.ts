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
  const record = await withTenantIsolationBypass(() =>
    db.jobRecord.create({
      data: {
        queue: params.queue,
        jobName: params.jobName,
        bullJobId: params.bullJobId ?? null,
        tenantId: params.tenantId ?? null,
        status: params.status,
        payload: params.payload ?? {},
        error: params.error ?? null,
        startedAt: params.startedAt,
        completedAt: params.completedAt ?? null,
      },
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
