import {
  inspectDeclaredOperationalUsage,
  recordDeclaredOperationalUsageSnapshot,
  recordOperationalUsageEvidenceAction,
  recordQueueOperationalUsageSnapshot,
} from '@pathfinder/db'
import { inspectQueueOperationalSnapshot } from '@pathfinder/jobs'

export { recordDeclaredOperationalUsageSnapshot, recordQueueOperationalUsageSnapshot }

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000
const ONE_DAY_MS = 24 * 60 * 60 * 1_000

type QueueSnapshot = Awaited<ReturnType<typeof inspectQueueOperationalSnapshot>>
type DeclaredUsageSnapshot = Awaited<ReturnType<typeof inspectDeclaredOperationalUsage>>
type RecordUsage = typeof recordOperationalUsageEvidenceAction

export async function startOperationalUsageObserver(
  onError: (error: unknown) => void,
  dependencies: {
    inspect?: () => Promise<QueueSnapshot>
    inspectDeclared?: () => Promise<DeclaredUsageSnapshot>
    record?: RecordUsage
    intervalMs?: number
    declaredIntervalMs?: number
  } = {},
) {
  let queueBusy = false
  let declaredBusy = false
  const observeQueue = async () => {
    if (queueBusy) return
    queueBusy = true
    try {
      const snapshot = await (dependencies.inspect ?? inspectQueueOperationalSnapshot)()
      await recordQueueOperationalUsageSnapshot(
        snapshot,
        dependencies.record ?? recordOperationalUsageEvidenceAction,
      )
    } catch (error: unknown) {
      onError(error)
    } finally {
      queueBusy = false
    }
  }
  const observeDeclared = async () => {
    if (declaredBusy) return
    declaredBusy = true
    try {
      const snapshot = await (dependencies.inspectDeclared ?? inspectDeclaredOperationalUsage)()
      await recordDeclaredOperationalUsageSnapshot(
        snapshot,
        dependencies.record ?? recordOperationalUsageEvidenceAction,
      )
    } catch (error: unknown) {
      onError(error)
    } finally {
      declaredBusy = false
    }
  }

  await Promise.all([observeQueue(), observeDeclared()])
  const queueTimer = setInterval(
    () => void observeQueue(),
    dependencies.intervalMs ?? FIFTEEN_MINUTES_MS,
  )
  const declaredTimer = setInterval(
    () => void observeDeclared(),
    dependencies.declaredIntervalMs ?? ONE_DAY_MS,
  )
  queueTimer.unref()
  declaredTimer.unref()
  return () => {
    clearInterval(queueTimer)
    clearInterval(declaredTimer)
  }
}
