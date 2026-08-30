import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  materialize: vi.fn(),
  readNext: vi.fn(),
  record: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging', DASHBOARD_URL: 'https://dashboard.example.test' },
  logger: { info: vi.fn(), error: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  materializeOperationalEventDeliveries: mocks.materialize,
  operationalEventDestinationKey: vi.fn(() => 'opaque-destination'),
  readNextOperationalEventDelivery: mocks.readNext,
  recordOperationalEventDeliveryAttempt: mocks.record,
  withTenantIsolationBypass: vi.fn((callback: () => unknown) => callback()),
}))
vi.mock('resend', () => ({ Resend: class {} }))

import { processOperationalEventDeliveries } from './operational-event-delivery'

const delivery = {
  id: 'delivery-1',
  tenantId: 'tenant-1',
  eventId: 'event-1',
  attemptCount: 0,
  event: {
    venueId: 'venue-1',
    severity: 'ERROR',
    title: 'Worker stalled',
    summary: 'A critical job did not make progress.',
    recommendedAction: 'Inspect the job record.',
  },
}

describe('operational event delivery processor', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stays dark without an explicitly configured route', async () => {
    await expect(processOperationalEventDeliveries()).resolves.toEqual({
      status: 'disabled',
      processed: 0,
    })
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.readNext).not.toHaveBeenCalled()
  })

  it('delivers a bounded outbox item and records sanitized audit evidence', async () => {
    mocks.readNext.mockResolvedValueOnce(delivery).mockResolvedValueOnce(null)
    const send = vi.fn().mockResolvedValue({ providerRef: 'provider-1' })
    await expect(
      processOperationalEventDeliveries({
        policy: {
          channel: 'EMAIL',
          destination: 'operator@example.test',
          minimumSeverity: 'ERROR',
        },
        adapter: { channel: 'EMAIL', provider: 'test-sink', send },
      }),
    ).resolves.toEqual({ status: 'enabled', processed: 1 })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[ERROR] Worker stalled',
        recordUrl: expect.stringContaining('/admin/clients/tenant-1/venues/venue-1/operations'),
      }),
    )
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SENT', provider: 'test-sink', providerRef: 'provider-1' }),
    )
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain('operator@example.test')
  })

  it('schedules bounded retry evidence without persisting provider details', async () => {
    mocks.readNext.mockResolvedValueOnce(delivery).mockResolvedValueOnce(null)
    const send = vi.fn().mockRejectedValue(new Error('secret provider response'))
    await processOperationalEventDeliveries({
      policy: { channel: 'EMAIL', destination: 'operator@example.test', minimumSeverity: 'ERROR' },
      adapter: { channel: 'EMAIL', provider: 'test-sink', send },
      now: new Date('2026-08-19T12:00:00Z'),
    })
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        errorCode: 'provider-failure',
        nextAttemptAt: new Date('2026-08-19T12:00:30Z'),
      }),
    )
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain('secret provider response')
  })

  it('suppresses the sixth failed attempt instead of retrying forever', async () => {
    mocks.readNext
      .mockResolvedValueOnce({ ...delivery, attemptCount: 5 })
      .mockResolvedValueOnce(null)
    const send = vi.fn().mockRejectedValue(new Error('provider rejected the request'))

    await processOperationalEventDeliveries({
      policy: { channel: 'EMAIL', destination: 'operator@example.test', minimumSeverity: 'ERROR' },
      adapter: { channel: 'EMAIL', provider: 'test-sink', send },
    })

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 6,
        status: 'SUPPRESSED',
        errorCode: 'retry-exhausted',
      }),
    )
    expect(mocks.record.mock.calls[0]?.[0]).not.toHaveProperty('nextAttemptAt')
  })

  it('processes at most 25 deliveries in one scheduler job', async () => {
    mocks.readNext.mockResolvedValue(delivery)
    const send = vi.fn().mockResolvedValue({})

    await expect(
      processOperationalEventDeliveries({
        policy: {
          channel: 'EMAIL',
          destination: 'operator@example.test',
          minimumSeverity: 'ERROR',
        },
        adapter: { channel: 'EMAIL', provider: 'test-sink', send },
      }),
    ).resolves.toEqual({ status: 'enabled', processed: 25 })

    expect(send).toHaveBeenCalledTimes(25)
    expect(mocks.record).toHaveBeenCalledTimes(25)
  })

  it('refuses a configured route when the injected adapter channel differs', async () => {
    await expect(
      processOperationalEventDeliveries({
        policy: {
          channel: 'EMAIL',
          destination: 'operator@example.test',
          minimumSeverity: 'ERROR',
        },
        adapter: { channel: 'WEBHOOK', provider: 'test-sink', send: vi.fn() },
      }),
    ).rejects.toThrow('Delivery adapter channel mismatch')
    expect(mocks.materialize).not.toHaveBeenCalled()
  })
})
