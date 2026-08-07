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
        create: expect.objectContaining({ bullJobId: 'weekly-report-report_1', status: 'RUNNING' }),
        update: expect.objectContaining({ bullJobId: 'weekly-report-report_1', status: 'RUNNING' }),
      }),
    )
  })
})
