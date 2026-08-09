import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  redrive: vi.fn(),
}))

vi.mock('@pathfinder/jobs', () => ({
  inspectTerminalJobRedrive: mocks.inspect,
  redriveTerminalJob: mocks.redrive,
}))

import {
  parseTerminalRedriveArgs,
  runTerminalRedriveCommand,
  terminalRedriveFinalError,
  terminalRedriveMutationWasAccepted,
  TerminalRedriveCleanupAggregateError,
  TerminalRedrivePostMutationAuditError,
} from './terminal-redrive-cli'

const writeAuditLog = vi.fn()
const loadEvidence = vi.fn()
const queue = { name: 'staging--weekly-report', getJob: vi.fn() }
const record = {
  id: 'record_1',
  queue: queue.name,
  jobName: 'weekly-report-process',
  bullJobId: 'job_1',
  tenantId: 'tenant_1',
  payload: { tenantId: 'tenant_1' },
  status: 'FAILED',
  attemptNumber: 6,
  maxAttempts: 6,
  failureDisposition: 'ATTEMPTS_EXHAUSTED',
  terminalAt: new Date('2026-08-08T12:00:00.000Z'),
}
const preview = {
  queueName: queue.name,
  bullJobId: 'job_1',
  jobName: 'weekly-report-process',
  terminalAt: '2026-08-08T12:00:00.000Z',
  attemptsMade: 6,
  attemptsStarted: 6,
  maxAttempts: 6,
  payloadDigest: 'b'.repeat(64),
  confirmationToken: `terminal-redrive-${'a'.repeat(64)}`,
}

beforeEach(() => {
  vi.resetAllMocks()
  loadEvidence.mockResolvedValue(record)
  mocks.inspect.mockResolvedValue({ preview, job: {} })
  mocks.redrive.mockResolvedValue(preview)
  writeAuditLog.mockResolvedValue(undefined)
})

describe('terminal redrive cleanup reporting', () => {
  it('preserves an accepted mutation through cleanup aggregation', () => {
    const error = terminalRedriveFinalError({
      primaryError: undefined,
      cleanupFailures: [new Error('close failed')],
      commandExecuted: true,
    })
    expect(error).toBeInstanceOf(TerminalRedriveCleanupAggregateError)
    expect(terminalRedriveMutationWasAccepted(error)).toBe(true)
  })

  it('preserves post-mutation audit ambiguity when cleanup also fails', () => {
    const error = terminalRedriveFinalError({
      primaryError: new TerminalRedrivePostMutationAuditError('audit failed'),
      cleanupFailures: [new Error('close failed')],
      commandExecuted: false,
    })
    expect(error).toBeInstanceOf(TerminalRedriveCleanupAggregateError)
    expect(terminalRedriveMutationWasAccepted(error)).toBe(true)
  })
})

describe('parseTerminalRedriveArgs', () => {
  const baseArgs = ['--actor-id', 'operator_1', '--queue', queue.name, '--job-id', 'job_1']

  it('defaults to preview in staging', () => {
    expect(parseTerminalRedriveArgs(baseArgs, { RAILWAY_ENVIRONMENT: 'staging' })).toEqual({
      actorId: 'operator_1',
      queueName: queue.name,
      bullJobId: 'job_1',
      execute: false,
    })
  })

  it('requires two independent exact execution confirmations', () => {
    expect(() =>
      parseTerminalRedriveArgs(
        [...baseArgs, '--execute', 'true', '--confirm', preview.confirmationToken],
        { RAILWAY_ENVIRONMENT: 'staging' },
      ),
    ).toThrow(/PATHFINDER_ALLOW_TERMINAL_REDRIVE/u)
    expect(
      parseTerminalRedriveArgs(
        [...baseArgs, '--execute', 'true', '--confirm', preview.confirmationToken],
        {
          RAILWAY_ENVIRONMENT: 'staging',
          PATHFINDER_ALLOW_TERMINAL_REDRIVE: 'staging-terminal-redrive',
        },
      ).execute,
    ).toBe(true)
  })

  it.each([
    ['production environment', baseArgs, { RAILWAY_ENVIRONMENT: 'production' }],
    ['unknown flag', [...baseArgs, '--force', 'true'], { RAILWAY_ENVIRONMENT: 'staging' }],
    ['duplicate flag', [...baseArgs, '--job-id', 'job_2'], { RAILWAY_ENVIRONMENT: 'staging' }],
    [
      'confirmation in preview',
      [...baseArgs, '--confirm', 'token'],
      { RAILWAY_ENVIRONMENT: 'staging' },
    ],
  ])('refuses %s', (_label, args, environment) => {
    expect(() => parseTerminalRedriveArgs(args, environment)).toThrow()
  })
})

describe('runTerminalRedriveCommand', () => {
  const dependencies = { queue, loadEvidence, writeAuditLog }

  it('returns a read-only preview without audit or mutation', async () => {
    await expect(
      runTerminalRedriveCommand(
        {
          actorId: 'operator_1',
          queueName: queue.name,
          bullJobId: 'job_1',
          execute: false,
        },
        { RAILWAY_ENVIRONMENT: 'staging' },
        dependencies,
      ),
    ).resolves.toEqual({ mode: 'preview', ...preview })
    expect(mocks.redrive).not.toHaveBeenCalled()
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('persists intent before mutation and acceptance after mutation', async () => {
    await runTerminalRedriveCommand(
      {
        actorId: 'operator_1',
        queueName: queue.name,
        bullJobId: 'job_1',
        execute: true,
        confirmationToken: preview.confirmationToken,
      },
      {
        RAILWAY_ENVIRONMENT: 'staging',
        PATHFINDER_ALLOW_TERMINAL_REDRIVE: 'staging-terminal-redrive',
      },
      dependencies,
    )

    expect(writeAuditLog).toHaveBeenCalledTimes(2)
    expect(writeAuditLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'JOB_TERMINAL_REDRIVE_REQUESTED' }),
    )
    expect(mocks.redrive.mock.invocationCallOrder[0]).toBeGreaterThan(
      writeAuditLog.mock.invocationCallOrder[0]!,
    )
    expect(writeAuditLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'JOB_TERMINAL_REDRIVE_ACCEPTED' }),
    )
  })

  it('does not mutate when the intent audit fails', async () => {
    writeAuditLog.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(
      runTerminalRedriveCommand(
        {
          actorId: 'operator_1',
          queueName: queue.name,
          bullJobId: 'job_1',
          execute: true,
          confirmationToken: preview.confirmationToken,
        },
        {
          RAILWAY_ENVIRONMENT: 'staging',
          PATHFINDER_ALLOW_TERMINAL_REDRIVE: 'staging-terminal-redrive',
        },
        dependencies,
      ),
    ).rejects.toThrow('database unavailable')
    expect(mocks.redrive).not.toHaveBeenCalled()
  })

  it('reports post-mutation audit ambiguity without attempting a second mutation', async () => {
    writeAuditLog.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write failed'))
    await expect(
      runTerminalRedriveCommand(
        {
          actorId: 'operator_1',
          queueName: queue.name,
          bullJobId: 'job_1',
          execute: true,
          confirmationToken: preview.confirmationToken,
        },
        {
          RAILWAY_ENVIRONMENT: 'staging',
          PATHFINDER_ALLOW_TERMINAL_REDRIVE: 'staging-terminal-redrive',
        },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(TerminalRedrivePostMutationAuditError)
    expect(mocks.redrive).toHaveBeenCalledTimes(1)
  })
})
