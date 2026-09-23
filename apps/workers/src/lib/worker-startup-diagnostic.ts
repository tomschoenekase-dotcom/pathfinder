export type WorkerStartupPhase =
  | 'release-identity'
  | 'startup-policy'
  | 'required-environment'
  | 'redis-connectivity'
  | 'runtime-start'

class WorkerStartupRejection extends Error {
  constructor(readonly phase: WorkerStartupPhase) {
    super('worker-startup-rejected')
    this.name = 'WorkerStartupRejection'
  }
}

/** Preserve fail-closed startup while never carrying dependency errors into public logs. */
export async function inWorkerStartupPhase<T>(
  phase: WorkerStartupPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch {
    throw new WorkerStartupRejection(phase)
  }
}

/** Only a locally constructed rejection can supply a phase; arbitrary errors are never serialized. */
export function workerStartupFailureEvent(error: unknown) {
  return {
    action: 'workers.start.failed' as const,
    errorCode: 'startup-rejected' as const,
    phase: error instanceof WorkerStartupRejection ? error.phase : ('runtime-start' as const),
  }
}
