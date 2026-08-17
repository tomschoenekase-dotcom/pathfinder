import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getDeliveryState: vi.fn(),
  beginDeliveryAttempt: vi.fn(),
  markDeliveryComplete: vi.fn(),
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
  getWelcomeEmailDeliveryState: mocks.getDeliveryState,
  beginWelcomeEmailDeliveryAttempt: mocks.beginDeliveryAttempt,
  markWelcomeEmailDeliveryComplete: mocks.markDeliveryComplete,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setResendClientForTesting, processSendWelcomeEmailJob } from './send-welcome-email'

describe('processSendWelcomeEmailJob', () => {
  const deliveryId = 'membership_1'
  const providerKey =
    'welcome-email-fbdab10e5d724336431c98c70a83541e44135422b6205413313230237fa87408'

  beforeEach(() => {
    vi.resetAllMocks()
    _setResendClientForTesting(null)
    mocks.env.RESEND_API_KEY = 'test-resend-key'
    mocks.env.RESEND_FROM_EMAIL = 'hello@example.com'
    mocks.env.DASHBOARD_URL = 'https://dashboard.example.com'
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.send.mockResolvedValue({})
    mocks.getDeliveryState.mockResolvedValue({ complete: false, attemptedAt: null })
    mocks.beginDeliveryAttempt.mockResolvedValue({
      complete: false,
      attemptedAt: new Date(),
    })
    mocks.markDeliveryComplete.mockResolvedValue(undefined)
  })

  it('sends the welcome email and marks the job complete', async () => {
    await processSendWelcomeEmailJob({
      tenantId: 'tenant_1',
      deliveryId,
      to: 'operator@example.com',
      recipientName: 'Ada Lovelace',
      orgName: 'Ada Venues',
    })

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'operator@example.com',
        subject: 'Welcome to Torchiko',
        html: expect.stringContaining('Ada Venues'),
      }),
      { idempotencyKey: providerKey },
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
    expect(mocks.markDeliveryComplete).toHaveBeenCalledWith('tenant_1', deliveryId)
    expect(mocks.beginDeliveryAttempt).toHaveBeenCalledWith('tenant_1', deliveryId)
    expect(mocks.beginDeliveryAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0]!,
    )
  })

  it('uses a stable, delivery-separated provider key without exposing the delivery ID', async () => {
    const basePayload = {
      tenantId: 'tenant_1',
      to: 'operator@example.com',
      recipientName: null,
      orgName: 'Ada Venues',
    }

    await processSendWelcomeEmailJob({ ...basePayload, deliveryId: 'membership_1' })
    await processSendWelcomeEmailJob({ ...basePayload, deliveryId: 'membership_1' })
    await processSendWelcomeEmailJob({ ...basePayload, deliveryId: 'membership_2' })

    const keys = mocks.send.mock.calls.map(
      (call) => (call[1] as { idempotencyKey: string }).idempotencyKey,
    )
    expect(keys[0]).toBe(providerKey)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    for (const key of keys) expect(key).toMatch(/^welcome-email-[a-f0-9]{64}$/u)
    expect(JSON.stringify(keys)).not.toContain('membership_')
  })

  it('fails open and completes the job when Resend is not configured', async () => {
    mocks.env.RESEND_API_KEY = undefined

    await processSendWelcomeEmailJob({
      tenantId: 'tenant_1',
      deliveryId,
      to: 'operator@example.com',
      recipientName: null,
      orgName: 'Ada Venues',
    })

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.markDeliveryComplete).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('marks the job failed and rethrows when Resend rejects', async () => {
    mocks.send.mockRejectedValueOnce(new Error('resend down'))

    await expect(
      processSendWelcomeEmailJob({
        tenantId: 'tenant_1',
        deliveryId,
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

  it('skips a delivery already completed durably without calling the provider', async () => {
    mocks.getDeliveryState.mockResolvedValue({ complete: true, attemptedAt: new Date() })

    await processSendWelcomeEmailJob({
      tenantId: 'tenant_1',
      deliveryId,
      to: 'operator@example.com',
      recipientName: null,
      orgName: 'Ada Venues',
    })

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.markDeliveryComplete).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('requires reconciliation instead of resending after provider idempotency expiry', async () => {
    mocks.getDeliveryState.mockResolvedValue({
      complete: false,
      attemptedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    await expect(
      processSendWelcomeEmailJob({
        tenantId: 'tenant_1',
        deliveryId,
        to: 'operator@example.com',
        recipientName: null,
        orgName: 'Ada Venues',
      }),
    ).rejects.toThrow('ambiguous and requires manual reconciliation')

    expect(mocks.beginDeliveryAttempt).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.markDeliveryComplete).not.toHaveBeenCalled()
  })

  it('treats a structured provider rejection as a retryable failure', async () => {
    mocks.send.mockResolvedValueOnce({ data: null, error: { message: 'provider rejected' } })

    await expect(
      processSendWelcomeEmailJob({
        tenantId: 'tenant_1',
        deliveryId,
        to: 'operator@example.com',
        recipientName: null,
        orgName: 'Ada Venues',
      }),
    ).rejects.toThrow('provider rejected')

    expect(mocks.markDeliveryComplete).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'a'.repeat(201)])(
    'rejects an invalid delivery identity before recording or sending: %s',
    async (invalidDeliveryId) => {
      await expect(
        processSendWelcomeEmailJob({
          tenantId: 'tenant_1',
          deliveryId: invalidDeliveryId,
          to: 'operator@example.com',
          recipientName: null,
          orgName: 'Ada Venues',
        }),
      ).rejects.toThrow('delivery ID must be a nonempty opaque identifier')

      expect(mocks.writeJobRecord).not.toHaveBeenCalled()
      expect(mocks.send).not.toHaveBeenCalled()
    },
  )
})
