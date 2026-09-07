import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ audit: vi.fn(), event: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  db: {},
  writeAuditLogStrict: mocks.audit,
  publishOperationalEvent: mocks.event,
}))

import { recordTenantAddOnInterest, requestTenantCancellation } from './customer-requests'

const environment = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_CANCELLATION_ENABLED: true,
} as never

describe('customer billing requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records a reason, requests period-end cancellation, and waits for the webhook', async () => {
    const agreement = {
      id: 'agreement-1',
      stripeSubscriptionId: 'sub_test',
      minimumCommitmentEndsAt: null,
      cancelAtPeriodEnd: false,
      status: 'ACTIVE',
    }
    const created = { id: 'request-1', status: 'PROCESSING' }
    const completed = { ...created, status: 'COMPLETED' }
    const tx = {
      billingCustomerRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn().mockResolvedValue(completed),
      },
      billingAccount: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'account-1', commercialAgreements: [agreement] }),
      },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }
    const provider = { cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined) }

    const result = await requestTenantCancellation({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      actorRole: 'OWNER',
      operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
      reason: 'The venue is closing for the season.',
      provider: provider as never,
      environment,
      client: client as never,
    })

    expect(result).toMatchObject({ replayed: false, awaitingWebhook: true })
    expect(provider.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_test',
        reason: 'The venue is closing for the season.',
      }),
    )
    expect(mocks.audit).toHaveBeenCalledTimes(2)
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'billing.subscription-ending',
          actionRequired: true,
        }),
      }),
    )
  })

  it('refuses cancellation during an active minimum commitment', async () => {
    const tx = {
      billingCustomerRequest: { findFirst: vi.fn().mockResolvedValue(null) },
      billingAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'account-1',
          commercialAgreements: [
            {
              id: 'agreement-1',
              stripeSubscriptionId: 'sub_test',
              minimumCommitmentEndsAt: new Date(Date.now() + 86_400_000),
              cancelAtPeriodEnd: false,
              status: 'ACTIVE',
            },
          ],
        }),
      },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }
    const provider = { cancelSubscriptionAtPeriodEnd: vi.fn() }
    await expect(
      requestTenantCancellation({
        tenantId: 'tenant-1',
        actorId: 'owner-1',
        actorRole: 'OWNER',
        operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
        reason: 'Closing for the season.',
        provider: provider as never,
        environment,
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PORTAL_POLICY' })
    expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('quarantines a provider cancellation failure as a durable failed request', async () => {
    const agreement = {
      id: 'agreement-1',
      stripeSubscriptionId: 'sub_test',
      minimumCommitmentEndsAt: null,
      cancelAtPeriodEnd: false,
      status: 'ACTIVE',
    }
    const created = { id: 'request-1', status: 'PROCESSING' }
    const tx = {
      billingCustomerRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
      billingAccount: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'account-1', commercialAgreements: [agreement] }),
      },
    }
    const client = {
      $transaction: (action: (value: typeof tx) => unknown) => action(tx),
      billingCustomerRequest: {
        update: vi.fn().mockResolvedValue({ ...created, status: 'FAILED' }),
      },
    }
    const providerError = new Error('test provider unavailable')
    const provider = { cancelSubscriptionAtPeriodEnd: vi.fn().mockRejectedValue(providerError) }

    await expect(
      requestTenantCancellation({
        tenantId: 'tenant-1',
        actorId: 'owner-1',
        actorRole: 'OWNER',
        operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
        reason: 'Closing for the season.',
        provider: provider as never,
        environment,
        client: client as never,
      }),
    ).rejects.toBe(providerError)
    expect(client.billingCustomerRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
  })

  it('rejects cross-tenant venue scope before recording add-on interest', async () => {
    const tx = {
      billingCustomerRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      billingAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'account-1' }) },
      venue: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }
    await expect(
      recordTenantAddOnInterest({
        tenantId: 'tenant-1',
        actorId: 'owner-1',
        actorRole: 'OWNER',
        operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
        featureKey: 'premium-voice',
        venueId: 'venue-other',
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tx.billingCustomerRequest.create).not.toHaveBeenCalled()
  })

  it.each(['completion', 'notification'])(
    'does not relabel provider success or resend cancellation after %s fails',
    async (stage) => {
      const processing = { id: 'request-1', status: 'PROCESSING' }
      const completed = { ...processing, status: 'COMPLETED' }
      const failure = new Error(`Internal ${stage} unavailable`)
      const tx = {
        billingCustomerRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(processing),
          update:
            stage === 'completion'
              ? vi.fn().mockRejectedValue(failure)
              : vi.fn().mockResolvedValue(completed),
        },
        billingAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'account-1',
            commercialAgreements: [
              {
                id: 'agreement-1',
                stripeSubscriptionId: 'sub_test',
                minimumCommitmentEndsAt: null,
                cancelAtPeriodEnd: false,
                status: 'ACTIVE',
              },
            ],
          }),
        },
      }
      const markFailed = vi.fn()
      const client = {
        $transaction: (action: (value: typeof tx) => unknown) => action(tx),
        billingCustomerRequest: { update: markFailed },
      }
      const provider = { cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined) }
      if (stage === 'notification') mocks.event.mockRejectedValueOnce(failure)
      const input = {
        tenantId: 'tenant-1',
        actorId: 'owner-1',
        actorRole: 'OWNER',
        operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
        reason: 'Seasonal closure',
        provider: provider as never,
        environment,
        client: client as never,
      }
      await expect(requestTenantCancellation(input)).rejects.toBe(failure)
      expect(markFailed).not.toHaveBeenCalled()
      tx.billingCustomerRequest.findFirst.mockResolvedValue(
        stage === 'completion' ? processing : completed,
      )
      await expect(requestTenantCancellation(input)).resolves.toMatchObject({
        replayed: true,
        awaitingWebhook: true,
        request: { status: stage === 'completion' ? 'PROCESSING' : 'COMPLETED' },
      })
      expect(provider.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(1)
    },
  )

  it('records approved catalog interest without charging or sending an email', async () => {
    const request = { id: 'request-1', featureKey: 'premium-voice', status: 'OPEN' }
    const tx = {
      billingCustomerRequest: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(request),
      },
      billingAccount: { findUnique: vi.fn().mockResolvedValue({ id: 'account-1' }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
    }
    const client = { $transaction: (action: (value: typeof tx) => unknown) => action(tx) }
    const result = await recordTenantAddOnInterest({
      tenantId: 'tenant-1',
      actorId: 'owner-1',
      actorRole: 'OWNER',
      operationId: '44a1e58c-670c-47d5-b02d-24c56b0e7747',
      featureKey: 'premium-voice',
      venueId: 'venue-1',
      client: client as never,
    })

    expect(result).toMatchObject({
      request: { id: 'request-1' },
      feature: { key: 'premium-voice' },
    })
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          eventType: 'billing.add-on-interest',
          recommendedAction: expect.stringContaining('draft'),
        }),
      }),
    )
  })
})
