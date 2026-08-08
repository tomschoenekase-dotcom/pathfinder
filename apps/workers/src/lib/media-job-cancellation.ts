import { UnrecoverableError, type Worker } from 'bullmq'

export class MediaAttemptDeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Media ingestion attempt exceeded its ${timeoutMs}-millisecond execution safety limit.`)
    this.name = 'MediaAttemptDeadlineExceededError'
  }
}

export class MediaJobCancelledError extends Error {
  constructor() {
    super('Media ingestion stopped after the worker lost its job lock.')
    this.name = 'MediaJobCancelledError'
  }
}

export function assertMediaJobActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof MediaAttemptDeadlineExceededError) throw signal.reason
  throw new MediaJobCancelledError()
}

export function normalizeMediaJobError(error: unknown, signal?: AbortSignal): unknown {
  if (!signal?.aborted) return error
  if (error instanceof UnrecoverableError) return error
  if (signal.reason instanceof MediaAttemptDeadlineExceededError) return signal.reason
  return error instanceof MediaJobCancelledError ? error : new MediaJobCancelledError()
}

type CancellableWorker = Pick<Worker, 'cancelAllJobs' | 'cancelJob'>

export function cancelMediaJobsAfterLockRenewalFailure(
  worker: CancellableWorker,
  jobIds: readonly string[],
): number {
  let cancelled = 0
  for (const jobId of new Set(jobIds)) {
    if (worker.cancelJob(jobId)) cancelled += 1
  }
  return cancelled
}

export function cancelAllMediaJobsAfterWorkerError(worker: CancellableWorker): void {
  worker.cancelAllJobs()
}
