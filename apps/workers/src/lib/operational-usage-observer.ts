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
  let stopping = false
  let queueInFlight: Promise<void> | undefined
  let declaredInFlight: Promise<void> | undefined

  const reportError = (error: unknown) => {
    try {
      onError(error)
    } catch {
      // Keep a diagnostic callback failure from escaping an interval task.
    }
  }

  const observeQueue = () => {
    if (stopping || queueInFlight) return queueInFlight ?? Promise.resolve()

    const execution = (async () => {
      try {
        const snapshot = await (dependencies.inspect ?? inspectQueueOperationalSnapshot)()
        await recordQueueOperationalUsageSnapshot(
          snapshot,
          dependencies.record ?? recordOperationalUsageEvidenceAction,
        )
      } catch (error: unknown) {
        reportError(error)
      }
    })().finally(() => {
      if (queueInFlight === execution) queueInFlight = undefined
    })
    queueInFlight = execution
    return execution
  }

  const observeDeclared = () => {
    if (stopping || declaredInFlight) return declaredInFlight ?? Promise.resolve()

    const execution = (async () => {
      try {
        const snapshot = await (dependencies.inspectDeclared ?? inspectDeclaredOperationalUsage)()
        await recordDeclaredOperationalUsageSnapshot(
          snapshot,
          dependencies.record ?? recordOperationalUsageEvidenceAction,
        )
      } catch (error: unknown) {
        reportError(error)
      }
    })().finally(() => {
      if (declaredInFlight === execution) declaredInFlight = undefined
    })
    declaredInFlight = execution
    return execution
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
  let stopPromise: Promise<void> | undefined
  return () => {
    stopPromise ??= (async () => {
      stopping = true
      clearInterval(queueTimer)
      clearInterval(declaredTimer)
      await Promise.all([queueInFlight, declaredInFlight])
    })()
    return stopPromise
  }
}
