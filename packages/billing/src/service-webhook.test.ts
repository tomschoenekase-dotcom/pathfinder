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

import { applyVerifiedStripeEvent, graceEndFor, type BillingEnvironment } from './index'

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
  const billingCheckoutAttempt = { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) }
  const tx = {
    billingEventApplication: { create: vi.fn().mockResolvedValue({}) },
    billingCheckoutAttempt,
    stripeWebhookReceipt,
  }
  const client = {
    stripeWebhookReceipt,
    billingAccount,
    commercialAgreement,
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  }
  return {
    client,
    tx,
    stripeWebhookReceipt,
    billingAccount,
    commercialAgreement,
    billingCheckoutAttempt,
  }
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

describe('verified Stripe event ownership and ordering', () => {
  beforeEach(() => vi.clearAllMocks())

  function checkoutEvent(type: string, created: number): Stripe.Event {
    return {
      id: `evt_${type}`,
      type,
      api_version: '2026-07-29.dahlia',
      created,
      livemode: false,
      data: { object: { id: 'cs_test_1', customer: 'cus_test', metadata: {} } },
    } as unknown as Stripe.Event
  }

  it('quarantines a subscription event whose agreement belongs to another tenant than the customer', async () => {
    const fixture = clientFixture()
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue(null)
    fixture.stripeWebhookReceipt.create.mockResolvedValue(receipt())
    fixture.billingAccount.findFirst.mockResolvedValue({
      id: 'account-a',
      tenantId: 'tenant-a',
      stripeCustomerId: 'cus_test',
    })
    fixture.commercialAgreement.findFirst.mockResolvedValue({
      id: 'agreement-b',
      tenantId: 'tenant-b',
      billingAccountId: 'account-b',
    })
    const result = await applyVerifiedStripeEvent({
      event: {
        id: 'evt_sub',
        type: 'customer.subscription.updated',
        api_version: '2026-07-29.dahlia',
        created: 1_777_000_000,
        livemode: false,
        data: { object: { id: 'sub_1', customer: 'cus_test', metadata: {} } },
      } as unknown as Stripe.Event,
      rawPayload: '{}',
      environment,
      client: fixture.client as never,
    })
    expect(result.status).toBe('quarantined')
    expect(fixture.client.$transaction).not.toHaveBeenCalled()
  })

  it('does not let a late Checkout expiry overwrite newer attempt state', async () => {
    const fixture = clientFixture()
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue(null)
    fixture.stripeWebhookReceipt.create.mockResolvedValue(receipt())
    fixture.billingAccount.findFirst.mockResolvedValue({
      id: 'account-a',
      tenantId: 'tenant-a',
      stripeCustomerId: 'cus_test',
    })
    fixture.billingCheckoutAttempt.findFirst.mockResolvedValue({
      id: 'attempt-a',
      tenantId: 'tenant-a',
      lastAppliedStripeEventAt: new Date(1_777_000_500 * 1000),
      lastAppliedStripeEventId: 'evt_newer',
    })
    const result = await applyVerifiedStripeEvent({
      event: checkoutEvent('checkout.session.expired', 1_777_000_100),
      rawPayload: '{}',
      environment,
      client: fixture.client as never,
    })
    expect(result.status).toBe('stale')
    expect(fixture.billingCheckoutAttempt.update).not.toHaveBeenCalled()
    expect(fixture.tx.billingEventApplication.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IGNORED_STALE' }) }),
    )
  })

  it('applies a newer Checkout event to the tenant-scoped attempt', async () => {
    const fixture = clientFixture()
    fixture.stripeWebhookReceipt.findUnique.mockResolvedValue(null)
    fixture.stripeWebhookReceipt.create.mockResolvedValue(receipt())
    fixture.billingAccount.findFirst.mockResolvedValue({
      id: 'account-a',
      tenantId: 'tenant-a',
      stripeCustomerId: 'cus_test',
    })
    fixture.billingCheckoutAttempt.findFirst.mockResolvedValue({
      id: 'attempt-a',
      tenantId: 'tenant-a',
      lastAppliedStripeEventAt: null,
      lastAppliedStripeEventId: null,
    })
    const result = await applyVerifiedStripeEvent({
      event: checkoutEvent('checkout.session.completed', 1_777_000_100),
      rawPayload: '{}',
      environment,
      client: fixture.client as never,
    })
    expect(result.status).toBe('applied')
    expect(fixture.billingCheckoutAttempt.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', stripeCheckoutSessionId: 'cs_test_1' },
    })
    expect(fixture.billingCheckoutAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'attempt-a', tenantId: 'tenant-a' } }),
    )
  })
})

describe('grace window', () => {
  const created = new Date('2026-09-10T00:00:00Z')

  it('starts at the first failure', () => {
    expect(
      graceEndFor({
        account: { status: 'ACTIVE', gracePeriodEndsAt: null },
        providerCreatedAt: created,
        days: 14,
      }).toISOString(),
    ).toBe('2026-09-24T00:00:00.000Z')
  })

  it('is not extended by later failures while already past due', () => {
    const existing = new Date('2026-09-20T00:00:00Z')
    expect(
      graceEndFor({
        account: { status: 'PAST_DUE', gracePeriodEndsAt: existing },
        providerCreatedAt: created,
        days: 14,
      }),
    ).toBe(existing)
  })
})
