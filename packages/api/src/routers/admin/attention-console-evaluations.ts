import { db } from '@pathfinder/db'
import { afterCondition, type AttentionConsoleInput } from './attention-pagination'

export function readAttentionEvaluations(
  cursor: AttentionConsoleInput['evaluationsCursor'],
  now: Date,
  take: number,
) {
  return db.evalRun.findMany({
    where: {
      AND: [
        {
          OR: [
            { status: { in: ['FAILED', 'STAGED', 'RETRY_SCHEDULED'] } },
            { status: 'RUNNING', executionLeaseExpiresAt: { lte: now } },
          ],
        },
        ...(afterCondition(cursor) ? [afterCondition(cursor)!] : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      status: true,
      attemptNumber: true,
      maxAttempts: true,
      executionLeaseExpiresAt: true,
      lastErrorCode: true,
      createdAt: true,
    },
  })
}
