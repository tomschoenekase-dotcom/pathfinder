import {
  checkDatabaseConnection,
  readOperationalHealth,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { checkBullMQConnection, inspectQueueOperationalSnapshot } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const PROBE_TIMEOUT_MS = 1_500

async function boundedProbe(probe: (timeoutMs: number) => Promise<unknown>) {
  try {
    await probe(PROBE_TIMEOUT_MS)
    return 'up' as const
  } catch {
    return 'down' as const
  }
}

async function boundedValue<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const adminOperationsReadinessRouter = router({
  operationsReadiness: adminProcedure.query(() =>
    withTenantIsolationBypass(async () => {
      const [database, redis, persisted, queues] = await Promise.all([
        boundedProbe(checkDatabaseConnection),
        boundedProbe(checkBullMQConnection),
        readOperationalHealth(),
        boundedValue(inspectQueueOperationalSnapshot(), PROBE_TIMEOUT_MS),
      ])
      return {
        status:
          database === 'up' &&
          redis === 'up' &&
          persisted.migration.parity &&
          persisted.worker.fresh
            ? ('ready' as const)
            : ('degraded' as const),
        probes: { database, redis },
        ...persisted,
        queue: queues ?? { status: 'probe-timeout', persisted: persisted.queue },
      }
    }),
  ),
})
