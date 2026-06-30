import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  env: {
    RESEND_API_KEY: 'test-resend-key' as string | undefined,
    RESEND_FROM_EMAIL: 'hello@example.com' as string | undefined,
    DASHBOARD_URL: 'https://dashboard.example.com' as string | undefined,
  },
}))

vi.mock('resend', () => ({
  Resend: vi.fn(() => ({
    emails: {
      send: mocks.send,
    },
  })),
}))

vi.mock('@pathfinder/config', () => ({
  env: mocks.env,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setResendClientForTesting, processSendWelcomeEmailJob } from './send-welcome-email'

describe('processSendWelcomeEmailJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setResendClientForTesting(null)
    mocks.env.RESEND_API_KEY = 'test-resend-key'
    mocks.env.RESEND_FROM_EMAIL = 'hello@example.com'
    mocks.env.DASHBOARD_URL = 'https://dashboard.example.com'
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.send.mockResolvedValue({})
  })

  it('sends the welcome email and marks the job complete', async () => {
    await processSendWelcomeEmailJob({
      tenantId: 'tenant_1',
      to: 'operator@example.com',
      recipientName: 'Ada Lovelace',
      orgName: 'Ada Venues',
    })

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'operator@example.com',
        subject: 'Welcome to PathFinder',
        html: expect.stringContaining('Ada Venues'),
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fails open and completes the job when Resend is not configured', async () => {
    mocks.env.RESEND_API_KEY = undefined

    await processSendWelcomeEmailJob({
      tenantId: 'tenant_1',
      to: 'operator@example.com',
      recipientName: null,
      orgName: 'Ada Venues',
    })

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('marks the job failed and rethrows when Resend rejects', async () => {
    mocks.send.mockRejectedValueOnce(new Error('resend down'))

    await expect(
      processSendWelcomeEmailJob({
        tenantId: 'tenant_1',
        to: 'operator@example.com',
        recipientName: 'Ada Lovelace',
        orgName: 'Ada Venues',
      }),
    ).rejects.toThrow('resend down')

    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED', error: 'resend down' }),
    )
  })
})
