import { db } from '@pathfinder/db'
import { after, type AttentionConsoleInput } from './attention-pagination'

export function readFailedAttentionJobs(cursor: AttentionConsoleInput['jobsCursor'], take: number) {
  return db.jobRecord.findMany({
    where: { status: 'FAILED', ...after(cursor) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      tenantId: true,
      queue: true,
      jobName: true,
      bullJobId: true,
      status: true,
      attemptNumber: true,
      maxAttempts: true,
      failureDisposition: true,
      terminalAt: true,
      createdAt: true,
    },
  })
}
