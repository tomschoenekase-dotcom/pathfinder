import type { Job } from 'bullmq'

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
      error: failureCode,
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
