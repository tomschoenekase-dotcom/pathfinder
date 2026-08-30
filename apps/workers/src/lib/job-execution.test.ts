import { UnrecoverableError } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  updateJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { error: mocks.loggerError },
}))

vi.mock('@pathfinder/db', () => ({
  updateJobRecord: mocks.updateJobRecord,
}))

import {
  classifyJobFailure,
  getJobExecutionMetadata,
  normalizeJobExecutionMetadata,
  recordJobFailure,
} from './job-execution'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.updateJobRecord.mockResolvedValue(undefined)
})

describe('getJobExecutionMetadata', () => {
  it('converts BullMQ zero-based attemptsMade into a one-based attempt number', () => {
    expect(
      getJobExecutionMetadata({ id: 'job_1', attemptsMade: 0, opts: { attempts: 6 } }),
    ).toEqual({ bullJobId: 'job_1', attemptNumber: 1, maxAttempts: 6 })
  })

  it('identifies the configured final attempt', () => {
    const execution = getJobExecutionMetadata({ attemptsMade: 5, opts: { attempts: 6 } })

    expect(execution).toEqual({ attemptNumber: 6, maxAttempts: 6 })
    expect(classifyJobFailure(new Error('still failing'), execution)).toBe('ATTEMPTS_EXHAUSTED')
  })

  it.each([undefined, 0])('normalizes configured attempts %s to one execution', (attempts) => {
    const opts = attempts === undefined ? {} : { attempts }

    expect(getJobExecutionMetadata({ attemptsMade: 0, opts })).toEqual({
      attemptNumber: 1,
      maxAttempts: 1,
    })
  })
})

describe('classifyJobFailure', () => {
  const firstOfSix = { attemptNumber: 1, maxAttempts: 6 }

  it('classifies BullMQ UnrecoverableError as unrecoverable before exhaustion', () => {
    expect(classifyJobFailure(new UnrecoverableError('invalid payload'), firstOfSix)).toBe(
      'UNRECOVERABLE',
    )
  })

  it('classifies errors carrying the BullMQ unrecoverable name as unrecoverable', () => {
    const error = new Error('invalid payload')
    error.name = 'UnrecoverableError'

    expect(classifyJobFailure(error, firstOfSix)).toBe('UNRECOVERABLE')
  })

  it('keeps an ordinary failure retry eligible before exhaustion', () => {
    expect(classifyJobFailure(new Error('temporary outage'), firstOfSix)).toBe('RETRY_ELIGIBLE')
  })
})

describe('normalizeJobExecutionMetadata', () => {
  it('normalizes a legacy Bull job id string to a single-attempt execution', () => {
    expect(normalizeJobExecutionMetadata('legacy_job_1')).toEqual({
      bullJobId: 'legacy_job_1',
      attemptNumber: 1,
      maxAttempts: 1,
    })
  })
})

describe('recordJobFailure', () => {
  it('persists the failure with its attempt metadata and retry disposition', async () => {
    await expect(
      recordJobFailure({
        jobRecordId: 'record_1',
        error: new Error('postgres://operator:secret@example.test/torchiko'),
        execution: { bullJobId: 'bull_1', attemptNumber: 2, maxAttempts: 6 },
      }),
    ).resolves.toBeUndefined()

    expect(mocks.updateJobRecord).toHaveBeenCalledWith('record_1', {
      status: 'FAILED',
      error: 'JOB_RETRY_ELIGIBLE',
      attemptNumber: 2,
      maxAttempts: 6,
      failureDisposition: 'RETRY_ELIGIBLE',
    })
    expect(JSON.stringify(mocks.updateJobRecord.mock.calls)).not.toContain('operator:secret')
  })

  it('absorbs JobRecord persistence errors so they cannot replace the processing failure', async () => {
    mocks.updateJobRecord.mockRejectedValueOnce(new Error('job record database unavailable'))

    await expect(
      recordJobFailure({
        jobRecordId: 'record_1',
        error: new UnrecoverableError('invalid payload'),
        execution: { attemptNumber: 1, maxAttempts: 6 },
      }),
    ).resolves.toBeUndefined()

    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'record_1',
      expect.objectContaining({ failureDisposition: 'UNRECOVERABLE' }),
    )
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.job-record.failure-persistence-failed',
        originalErrorCode: 'JOB_UNRECOVERABLE',
      }),
    )
  })
})
