import { UnrecoverableError, type Job } from 'bullmq'

import { updateJobRecord, type JobFailureDisposition } from '@pathfinder/db'
import { logger } from '@pathfinder/config'

export type JobExecutionMetadata = {
  bullJobId?: string
  attemptNumber: number
  maxAttempts: number
}

export type JobExecutionInput = JobExecutionMetadata | string | null | undefined

export function getJobExecutionMetadata(
  job: Pick<Job, 'id' | 'attemptsMade' | 'opts'>,
): JobExecutionMetadata {
  const configuredAttempts = job.opts.attempts
  const maxAttempts =
    Number.isInteger(configuredAttempts) && (configuredAttempts ?? 0) > 0
      ? (configuredAttempts as number)
      : 1

  return {
    ...(job.id === undefined ? {} : { bullJobId: job.id }),
    attemptNumber: job.attemptsMade + 1,
    maxAttempts,
  }
}

export function normalizeJobExecutionMetadata(input: JobExecutionInput): JobExecutionMetadata {
  if (typeof input === 'object' && input !== null) return input
  return {
    ...(typeof input === 'string' ? { bullJobId: input } : {}),
    attemptNumber: 1,
    maxAttempts: 1,
  }
}

export function classifyJobFailure(
  error: unknown,
  execution: JobExecutionMetadata,
): JobFailureDisposition {
  if (
    error instanceof Error
      ? error.constructor.name === 'UnrecoverableError' || error.name === 'UnrecoverableError'
      : typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'UnrecoverableError'
  ) {
    return 'UNRECOVERABLE'
  }

  return execution.attemptNumber >= execution.maxAttempts ? 'ATTEMPTS_EXHAUSTED' : 'RETRY_ELIGIBLE'
}

/**
 * BullMQ retains a thrown error's message as failedReason. Convert processor
 * failures to a finite product-owned code before they cross that durable queue
 * boundary, while preserving whether BullMQ should stop retrying the job.
 * Deliberately do not retain the original error as a cause: BullMQ serializes
 * error metadata, and provider/database messages must remain private.
 */
export function toQueueSafeJobError(error: unknown, failureCode: string): Error {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(failureCode)) {
    throw new Error('Queue-safe job failure code is invalid')
  }

  return classifyJobFailure(error, { attemptNumber: 1, maxAttempts: 2 }) === 'UNRECOVERABLE'
    ? new UnrecoverableError(failureCode)
    : new Error(failureCode)
}

export async function recordJobFailure(params: {
  jobRecordId: string
  error: unknown
  execution: JobExecutionMetadata
}): Promise<void> {
  const failureDisposition = classifyJobFailure(params.error, params.execution)
  const failureCode = `JOB_${failureDisposition}`

  try {
    await updateJobRecord(params.jobRecordId, {
      status: 'FAILED',
      attemptNumber: params.execution.attemptNumber,
      maxAttempts: params.execution.maxAttempts,
      failureDisposition,
    })
  } catch (persistenceError) {
    logger.error({
      action: 'workers.job-record.failure-persistence-failed',
      jobRecordId: params.jobRecordId,
      attemptNumber: params.execution.attemptNumber,
      maxAttempts: params.execution.maxAttempts,
      failureDisposition,
      originalErrorCode: failureCode,
      error:
        persistenceError instanceof Error
          ? persistenceError.message
          : 'Unknown job record persistence error',
    })
  }
}
