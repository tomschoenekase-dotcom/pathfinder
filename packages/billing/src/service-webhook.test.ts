import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

const publications = vi.hoisted(() => ({ tenant: vi.fn(), platform: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: {},
  publishOperationalEvent: publications.tenant,
  publishPlatformOperationalEvent: publications.platform,
  withTenantIsolationBypass: (operation: () => unknown) => operation(),
  writeAuditLogStrict: vi.fn(),
}))

import { applyVerifiedStripeEvent, type BillingEnvironment } from './index'

const environment = {
  STRIPE_MODE: 'test',
  STRIPE_ACCOUNT_NAMESPACE: 'torchiko-test',
  STRIPE_WEBHOOK_PROCESSING_ENABLED: true,
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  BILLING_GRACE_PERIOD_DAYS: 14,
} as BillingEnvironment

function event(tenantId = 'tenant-a'): Stripe.Event {
  return {
    id: 'evt_test',
    type: 'customer.updated',
    api_version: '2026-07-29.dahlia',
    created: 1_777_000_000,
    livemode: false,
    data: { object: { id: 'cus_test', metadata: { torchiko_tenant_id: tenantId } } },
  } as unknown as Stripe.Event
}

function receipt(status = 'RECEIVED') {
  return {
    id: 'receipt-a',
    payloadHash: 'unused',
    processingStatus: status,
    lastAttemptAt: null,
  }
}

function clientFixture() {
  const stripeWebhookReceipt = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  }
  const billingAccount = { findFirst: vi.fn() }
  const commercialAgreement = { findFirst: vi.fn() }
  const tx = {
    billingEventApplication: { create: vi.fn().mockResolvedValue({}) },
    stripeWebhookReceipt,
  }
  const client = {
    stripeWebhookReceipt,
    billingAccount,
    commercialAgreement,
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  }
  return { client, tx, stripeWebhookReceipt, billingAccount }
}

describe('verified Stripe receipt lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deduplicates a terminal event before any projection effect', async () => {
    const fixture = clientFixture()
    const rawPayload = '{}'
    const hash = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(rawPayload).digest('hex'),
    )
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue({
      ...receipt('APPLIED'),
      payloadHash: hash,
    })
    await expect(
      applyVerifiedStripeEvent({
        event: event(),
        rawPayload,
        environment,
        client: fixture.client as never,
      }),
    ).resolves.toEqual({ status: 'duplicate', receiptId: 'receipt-a' })
    expect(fixture.billingAccount.findFirst).not.toHaveBeenCalled()
  })

  it('durably quarantines unknown and cross-tenant provider objects', async () => {
    const fixture = clientFixture()
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue(null)
    fixture.stripeWebhookReceipt.create.mockResolvedValue(receipt())
    fixture.billingAccount.findFirst.mockResolvedValue({
      id: 'account-a',
      tenantId: 'tenant-a',
      stripeCustomerId: 'cus_test',
    })
    const result = await applyVerifiedStripeEvent({
      event: event('tenant-b'),
      rawPayload: '{}',
      environment,
      client: fixture.client as never,
    })
    expect(result.status).toBe('quarantined')
    expect(fixture.stripeWebhookReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingStatus: 'QUARANTINED' }),
      }),
    )
    expect(publications.platform).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ eventType: 'billing.unknown-stripe-object' }),
      }),
    )
  })

  it('reprocesses a failed durable receipt instead of dropping it as a duplicate', async () => {
    const fixture = clientFixture()
    const rawPayload = '{}'
    const hash = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(rawPayload).digest('hex'),
    )
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue({
      ...receipt('FAILED'),
      payloadHash: hash,
    })
    fixture.billingAccount.findFirst.mockResolvedValue({
      id: 'account-a',
      tenantId: 'tenant-a',
      stripeCustomerId: 'cus_test',
    })
    await expect(
      applyVerifiedStripeEvent({
        event: event(),
        rawPayload,
        environment,
        client: fixture.client as never,
      }),
    ).resolves.toEqual({ status: 'stale', receiptId: 'receipt-a' })
    expect(fixture.tx.billingEventApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'IGNORED_STALE' }),
      }),
    )
    expect(fixture.stripeWebhookReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptCount: { increment: 1 } }),
      }),
    )
  })
})
