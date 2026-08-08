import type { Worker } from 'bullmq'

export class MediaJobCancelledError extends Error {
  constructor() {
    super('Media ingestion stopped after the worker lost its job lock.')
    this.name = 'MediaJobCancelledError'
  }
}

export function assertMediaJobActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaJobCancelledError()
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
