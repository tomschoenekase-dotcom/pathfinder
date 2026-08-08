import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WEEKLY_REPORT_PROCESS_JOB, WEEKLY_REPORT_QUEUE } from './queues'
import {
  inspectTerminalJobRedrive,
  redriveTerminalJob,
  supportedTerminalRedriveQueues,
  TerminalRedriveRefusal,
  type TerminalJobRecordEvidence,
  type TerminalRedriveQueue,
} from './terminal-redrive'

const retry = vi.fn()
const getState = vi.fn()
const getJob = vi.fn()

function evidence(overrides: Partial<TerminalJobRecordEvidence> = {}): TerminalJobRecordEvidence {
  return {
    id: 'record_1',
    queue: WEEKLY_REPORT_QUEUE,
    jobName: WEEKLY_REPORT_PROCESS_JOB,
    bullJobId: 'weekly-report-report_1',
    tenantId: 'tenant_1',
    payload: { tenantId: 'tenant_1', reportId: 'report_1' },
    status: 'FAILED',
    attemptNumber: 6,
    maxAttempts: 6,
    failureDisposition: 'ATTEMPTS_EXHAUSTED',
    terminalAt: new Date('2026-08-08T12:00:00.000Z'),
    ...overrides,
  }
}

function queue(jobOverrides: Record<string, unknown> = {}): TerminalRedriveQueue {
  getJob.mockResolvedValue({
    id: 'weekly-report-report_1',
    name: WEEKLY_REPORT_PROCESS_JOB,
    data: { tenantId: 'tenant_1', reportId: 'report_1' },
    attemptsMade: 6,
    attemptsStarted: 6,
    opts: { attempts: 6 },
    getState,
    retry,
    ...jobOverrides,
  })
  return { name: WEEKLY_REPORT_QUEUE, getJob }
}

beforeEach(() => {
  vi.resetAllMocks()
  getState.mockResolvedValue('failed')
  retry.mockResolvedValue(undefined)
})

describe('inspectTerminalJobRedrive', () => {
  it('previews an exact attempts-exhausted retained job without mutating it', async () => {
    const result = await inspectTerminalJobRedrive({
      queue: queue(),
      bullJobId: 'weekly-report-report_1',
      evidence: evidence(),
    })

    expect(result.preview).toEqual({
      queueName: WEEKLY_REPORT_QUEUE,
      bullJobId: 'weekly-report-report_1',
      jobName: WEEKLY_REPORT_PROCESS_JOB,
      terminalAt: '2026-08-08T12:00:00.000Z',
      attemptsMade: 6,
      attemptsStarted: 6,
      maxAttempts: 6,
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      confirmationToken: expect.stringMatching(/^terminal-redrive-[0-9a-f]{64}$/u),
    })
    expect(retry).not.toHaveBeenCalled()
  })

  it('exposes only explicitly approved leaf queues', () => {
    expect(supportedTerminalRedriveQueues()).toContain(WEEKLY_REPORT_QUEUE)
    expect(supportedTerminalRedriveQueues()).not.toContain('staging--generation-dispatch')
    expect(supportedTerminalRedriveQueues()).not.toContain('staging--generation-recovery')
  })

  it.each([
    ['missing record', null],
    ['unrecoverable', evidence({ failureDisposition: 'UNRECOVERABLE' })],
    ['not terminal', evidence({ status: 'RUNNING' })],
    ['missing timestamp', evidence({ terminalAt: null })],
    ['partial attempt', evidence({ attemptNumber: 5 })],
    ['wrong tenant', evidence({ tenantId: 'tenant_2' })],
    ['missing tenant', evidence({ tenantId: null })],
    ['payload drift', evidence({ payload: { tenantId: 'tenant_1', reportId: 'other' } })],
  ])('refuses %s evidence', async (_label, record) => {
    await expect(
      inspectTerminalJobRedrive({
        queue: queue(),
        bullJobId: 'weekly-report-report_1',
        evidence: record,
      }),
    ).rejects.toBeInstanceOf(TerminalRedriveRefusal)
  })

  it.each([
    ['waiting state', { state: 'waiting' }],
    ['wrong name', { name: 'weekly-report-recovery' }],
    ['attempt mismatch', { attemptsMade: 5 }],
    ['started-attempt mismatch', { attemptsStarted: 5 }],
    ['configured-attempt mismatch', { opts: { attempts: 7 } }],
  ])('refuses BullMQ %s', async (_label, change) => {
    if ('state' in change) getState.mockResolvedValue(change.state)
    const jobChange = 'state' in change ? {} : change
    await expect(
      inspectTerminalJobRedrive({
        queue: queue(jobChange),
        bullJobId: 'weekly-report-report_1',
        evidence: evidence(),
      }),
    ).rejects.toBeInstanceOf(TerminalRedriveRefusal)
  })

  it('refuses unsupported queues before reading Redis', async () => {
    await expect(
      inspectTerminalJobRedrive({
        queue: { name: 'staging--generation-dispatch', getJob },
        bullJobId: 'dispatch_1',
        evidence: evidence({ queue: 'staging--generation-dispatch', bullJobId: 'dispatch_1' }),
      }),
    ).rejects.toBeInstanceOf(TerminalRedriveRefusal)
    expect(getJob).not.toHaveBeenCalled()
  })
})

describe('redriveTerminalJob', () => {
  it('requires the current preview token and resets both BullMQ attempt counters', async () => {
    const redriveQueue = queue()
    const record = evidence()
    const { preview } = await inspectTerminalJobRedrive({
      queue: redriveQueue,
      bullJobId: 'weekly-report-report_1',
      evidence: record,
    })

    await expect(
      redriveTerminalJob({
        queue: redriveQueue,
        bullJobId: 'weekly-report-report_1',
        evidence: record,
        confirmationToken: preview.confirmationToken,
      }),
    ).resolves.toEqual(preview)
    expect(retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    })
  })

  it('refuses stale or mistyped confirmation without retrying', async () => {
    await expect(
      redriveTerminalJob({
        queue: queue(),
        bullJobId: 'weekly-report-report_1',
        evidence: evidence(),
        confirmationToken: 'terminal-redrive-wrong',
      }),
    ).rejects.toBeInstanceOf(TerminalRedriveRefusal)
    expect(retry).not.toHaveBeenCalled()
  })
})
