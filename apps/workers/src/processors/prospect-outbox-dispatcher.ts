import { logger } from '@pathfinder/config'
import { db } from '@pathfinder/db'
import { enqueueProspectOutreach } from '@pathfinder/jobs'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_BATCH_SIZE = 100

export async function dispatchPendingProspectOutbox(
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<{ discovered: number; enqueued: number; failed: number }> {
  if (process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED !== 'true') {
    return { discovered: 0, enqueued: 0, failed: 0 }
  }
  const control = await db.prospectDeliveryControl.findUnique({
    where: { id: 'global' },
    select: { deliveryEnabled: true },
  })
  if (!control?.deliveryEnabled) {
    return { discovered: 0, enqueued: 0, failed: 0 }
  }
  const operations = await db.prospectSendOutbox.findMany({
    where: {
      availableAt: { lte: now },
      OR: [
        { status: { in: ['PENDING', 'RETRYABLE'] }, claimOwner: null },
        { status: 'CLAIMED', claimExpiresAt: { lt: now } },
      ],
    },
    orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    take: Math.max(1, Math.min(batchSize, 500)),
  })

  const results = await Promise.allSettled(
    operations.map(({ id }) => enqueueProspectOutreach({ outboxId: id })),
  )
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) {
    logger.error({
      action: 'workers.prospect-outbox.dispatch.partial-failure',
      discovered: operations.length,
      failed,
      error: 'One or more durable outbox operations could not be published',
    })
  }
  return { discovered: operations.length, enqueued: operations.length - failed, failed }
}

/**
 * Periodically republishes durable outbox intent. It never calls a provider and
 * remains disabled unless the internal prospect-outreach server flag is on.
 */
export function startProspectOutboxDispatcher(
  intervalMs = DEFAULT_INTERVAL_MS,
): () => Promise<void> {
  if (process.env.CRM_PROSPECT_OUTREACH_ENABLED !== 'true') {
    logger.info({ action: 'workers.prospect-outbox.dispatch.disabled' })
    return async () => undefined
  }

  let stopping = false
  let inFlightDispatch: Promise<void> | undefined
  const dispatch = () => {
    if (stopping || inFlightDispatch) return inFlightDispatch ?? Promise.resolve()

    const execution = dispatchPendingProspectOutbox()
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          logger.error({
            action: 'workers.prospect-outbox.dispatch.failed',
            error: error instanceof Error ? error.message : 'Unknown outbox dispatcher error',
          })
        } catch {
          // Keep a diagnostic failure from escaping the interval task.
        }
      })
      .finally(() => {
        if (inFlightDispatch === execution) inFlightDispatch = undefined
      })
    inFlightDispatch = execution
    return execution
  }

  void dispatch()
  const timer = setInterval(() => void dispatch(), intervalMs)
  timer.unref()
  let stopPromise: Promise<void> | undefined
  return () => {
    stopPromise ??= (async () => {
      stopping = true
      clearInterval(timer)
      await inFlightDispatch
    })()
    return stopPromise
  }
}
