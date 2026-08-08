import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
const upsertMock = vi.fn()
const updateMock = vi.fn()

vi.mock('../client', () => ({
  db: {
    jobRecord: {
      create: createMock,
      upsert: upsertMock,
      update: updateMock,
    },
  },
}))

describe('writeJobRecord', () => {
  beforeEach(() => {
    createMock.mockReset()
    upsertMock.mockReset()
    updateMock.mockReset()
  })

  it('creates a plain record when bullJobId is absent (no retry collision risk)', async () => {
    createMock.mockResolvedValueOnce({ id: 'record_1' })

    const { writeJobRecord } = await import('./job-records')

    const id = await writeJobRecord({
      queue: 'weekly-report',
      jobName: 'weekly-report-process',
      status: 'RUNNING',
      startedAt: new Date('2026-07-05T00:00:00.000Z'),
    })

    expect(id).toBe('record_1')
    expect(createMock).toHaveBeenCalled()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('upserts on queue and bullJobId so another queue cannot overwrite the retry record', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'record_1' })

    const { writeJobRecord } = await import('./job-records')

    const id = await writeJobRecord({
      queue: 'weekly-report',
      jobName: 'weekly-report-process',
      bullJobId: 'weekly-report-report_1',
      status: 'RUNNING',
      startedAt: new Date('2026-07-05T00:00:00.000Z'),
      attemptNumber: 2,
      maxAttempts: 6,
    })

    expect(id).toBe('record_1')
    expect(createMock).not.toHaveBeenCalled()
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          queue_bullJobId: {
            queue: 'weekly-report',
            bullJobId: 'weekly-report-report_1',
          },
        },
        create: expect.objectContaining({
          bullJobId: 'weekly-report-report_1',
          status: 'RUNNING',
          attemptNumber: 2,
          maxAttempts: 6,
          error: null,
          completedAt: null,
          failureDisposition: null,
          terminalAt: null,
        }),
        update: expect.objectContaining({
          bullJobId: 'weekly-report-report_1',
          status: 'RUNNING',
          attemptNumber: 2,
          maxAttempts: 6,
          error: null,
          completedAt: null,
          failureDisposition: null,
          terminalAt: null,
        }),
      }),
    )
  })
})

describe('updateJobRecord', () => {
  beforeEach(() => {
    updateMock.mockReset()
    updateMock.mockResolvedValue({ id: 'record_1' })
  })

  it('records retry-eligible failure without a terminal timestamp', async () => {
    const { updateJobRecord } = await import('./job-records')
    const completedAt = new Date('2026-08-07T23:58:00.000Z')

    await updateJobRecord('record_1', {
      status: 'FAILED',
      error: 'temporary outage',
      attemptNumber: 1,
      maxAttempts: 6,
      failureDisposition: 'RETRY_ELIGIBLE',
      completedAt,
    })

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'record_1' },
      data: {
        status: 'FAILED',
        error: 'temporary outage',
        attemptNumber: 1,
        maxAttempts: 6,
        failureDisposition: 'RETRY_ELIGIBLE',
        terminalAt: null,
        completedAt,
      },
    })
  })

  it.each(['ATTEMPTS_EXHAUSTED', 'UNRECOVERABLE'] as const)(
    'records %s failure with the attempt completion as terminal time',
    async (failureDisposition) => {
      const { updateJobRecord } = await import('./job-records')
      const completedAt = new Date('2026-08-07T23:59:00.000Z')

      await updateJobRecord('record_1', {
        status: 'FAILED',
        error: 'permanent failure',
        attemptNumber: 6,
        maxAttempts: 6,
        failureDisposition,
        completedAt,
      })

      expect(updateMock).toHaveBeenCalledWith({
        where: { id: 'record_1' },
        data: expect.objectContaining({
          status: 'FAILED',
          failureDisposition,
          terminalAt: completedAt,
          completedAt,
        }),
      })
    },
  )

  it('clears stale failure lifecycle fields when the job completes', async () => {
    const { updateJobRecord } = await import('./job-records')
    const completedAt = new Date('2026-08-08T00:00:00.000Z')

    await updateJobRecord('record_1', { status: 'COMPLETE', completedAt })

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'record_1' },
      data: {
        status: 'COMPLETE',
        error: null,
        failureDisposition: null,
        terminalAt: null,
        completedAt,
      },
    })
  })
})
