import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  apply: vi.fn(),
}))

vi.mock('@pathfinder/billing', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  parseBillingEnvironment: () => ({
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_ACCOUNT_NAMESPACE: 'torchiko-test',
  }),
  createStripeClient: vi.fn(() => ({})),
  StripeBillingProvider: class {
    constructWebhookEvent = mocks.construct
  },
  applyVerifiedStripeEvent: mocks.apply,
}))

import { POST } from './route'

describe('Stripe webhook ingress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_WEBHOOK_PROCESSING_ENABLED = 'true'
    process.env.DASHBOARD_URL = 'http://localhost:3001'
    process.env.STRIPE_MODE = 'test'
    process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'
    process.env.STRIPE_ACCOUNT_NAMESPACE = 'torchiko-test'
    mocks.construct.mockReturnValue({
      id: 'evt_test',
      type: 'invoice.paid',
      api_version: '2026-07-29.dahlia',
      livemode: false,
    })
    mocks.apply.mockResolvedValue({ status: 'applied' })
  })

  it('is not exposed when the webhook kill switch is off', async () => {
    process.env.STRIPE_WEBHOOK_PROCESSING_ENABLED = 'false'
    const response = await POST(
      new Request('http://localhost/api/webhooks/stripe', { method: 'POST' }),
    )
    expect(response.status).toBe(404)
  })

  it('rejects a missing signature before reading or processing the body', async () => {
    const response = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: '{"private":"value"}',
      }),
    )
    expect(response.status).toBe(401)
    expect(mocks.construct).not.toHaveBeenCalled()
  })

  it('verifies the exact raw body and applies only the verified event', async () => {
    const body = '{ "id": "evt_test", "spacing": true }'
    const response = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body,
        headers: { 'stripe-signature': 't=1,v1=fake' },
      }),
    )
    expect(response.status).toBe(200)
    expect(mocks.construct).toHaveBeenCalledWith(body, 't=1,v1=fake', 'whsec_fixture')
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ rawPayload: body }))
  })

  it('rejects an endpoint API-version mismatch', async () => {
    mocks.construct.mockReturnValue({
      id: 'evt_old',
      type: 'invoice.paid',
      api_version: '2025-01-01',
      livemode: false,
    })
    const response = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: '{}',
        headers: { 'stripe-signature': 'fake' },
      }),
    )
    expect(response.status).toBe(400)
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it('rejects an invalid Stripe signature and retries processing failures', async () => {
    mocks.construct.mockImplementationOnce(() => {
      throw new Error('invalid signature')
    })
    const invalid = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: '{}',
        headers: { 'stripe-signature': 'invalid' },
      }),
    )
    expect(invalid.status).toBe(401)

    mocks.construct.mockReturnValue({
      id: 'evt_retry',
      type: 'invoice.paid',
      api_version: '2026-07-29.dahlia',
      livemode: false,
    })
    mocks.apply.mockRejectedValueOnce(new Error('temporary database failure'))
    const retryable = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: '{}',
        headers: { 'stripe-signature': 'valid' },
      }),
    )
    expect(retryable.status).toBe(503)
  })

  it('bounds the declared payload before verification', async () => {
    const response = await POST(
      new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: '{}',
        headers: { 'stripe-signature': 'fake', 'content-length': '300000' },
      }),
    )
    expect(response.status).toBe(413)
    expect(mocks.construct).not.toHaveBeenCalled()
  })
})
