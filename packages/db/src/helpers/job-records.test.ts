import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMock = vi.fn()
const upsertMock = vi.fn()
const updateMock = vi.fn()
const findUniqueMock = vi.fn()

vi.mock('../client', () => ({
  db: {
    jobRecord: {
      create: createMock,
      findUnique: findUniqueMock,
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
    findUniqueMock.mockReset()
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

  it('persists exact venue scope separately from the opaque execution payload', async () => {
    createMock.mockResolvedValueOnce({ id: 'record_venue' })
    const { writeJobRecord } = await import('./job-records')

    await writeJobRecord({
      queue: 'evaluation-run',
      jobName: 'evaluation-run-process',
      tenantId: 'tenant_1',
      status: 'RUNNING',
      payload: { venueId: 'venue_1', privatePrompt: 'must remain opaque' },
      startedAt: new Date('2026-08-23T12:00:00.000Z'),
    })

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          payload: { venueId: 'venue_1', privatePrompt: 'must remain opaque' },
        }),
      }),
    )
  })
})

describe('findTerminalJobRecordEvidence', () => {
  beforeEach(() => {
    findUniqueMock.mockReset()
  })

  it('uses the exact queue-scoped BullMQ identity and returns only redrive evidence', async () => {
    const record = {
      id: 'record_1',
      queue: 'weekly-report',
      jobName: 'weekly-report-process',
      bullJobId: 'job_1',
      tenantId: 'tenant_1',
      payload: { tenantId: 'tenant_1', reportId: 'report_1' },
      status: 'FAILED',
      attemptNumber: 6,
      maxAttempts: 6,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
      terminalAt: new Date('2026-08-08T12:00:00.000Z'),
    }
    findUniqueMock.mockResolvedValueOnce(record)
    const { findTerminalJobRecordEvidence } = await import('./job-records')

    await expect(
      findTerminalJobRecordEvidence({ queue: 'weekly-report', bullJobId: 'job_1' }),
    ).resolves.toEqual(record)
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        queue_bullJobId: { queue: 'weekly-report', bullJobId: 'job_1' },
      },
      select: {
        id: true,
        queue: true,
        jobName: true,
        bullJobId: true,
        tenantId: true,
        payload: true,
        status: true,
        attemptNumber: true,
        maxAttempts: true,
        failureDisposition: true,
        terminalAt: true,
      },
    })
  })

  it('loads the same bounded evidence by record ID for an operator preview', async () => {
    findUniqueMock.mockResolvedValueOnce(null)
    const { findTerminalJobRecordEvidenceById } = await import('./job-records')

    await expect(findTerminalJobRecordEvidenceById('record_1')).resolves.toBeNull()
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 'record_1' },
      select: {
        id: true,
        queue: true,
        jobName: true,
        bullJobId: true,
        tenantId: true,
        payload: true,
        status: true,
        attemptNumber: true,
        maxAttempts: true,
        failureDisposition: true,
        terminalAt: true,
      },
    })
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
