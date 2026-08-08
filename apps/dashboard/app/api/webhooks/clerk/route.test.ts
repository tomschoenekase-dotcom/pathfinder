import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  handleClerkEvent: vi.fn(),
  isClerkWebhookReceiptConflictError: vi.fn(),
  enqueueWelcomeEmail: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('svix', () => ({
  Webhook: vi.fn().mockImplementation(() => ({ verify: mocks.verify })),
}))
vi.mock('@pathfinder/config', () => ({
  env: { CLERK_WEBHOOK_SECRET: 'test-webhook-secret' },
  logger: { error: mocks.loggerError },
}))
vi.mock('@pathfinder/db', () => ({
  handleClerkEvent: mocks.handleClerkEvent,
  isClerkWebhookReceiptConflictError: mocks.isClerkWebhookReceiptConflictError,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueWelcomeEmail: mocks.enqueueWelcomeEmail }))

import { POST } from './route'

function request(): Request {
  return new Request('https://dashboard.example/api/webhooks/clerk', {
    method: 'POST',
    body: '{}',
    headers: {
      'svix-id': 'msg_test',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,test',
    },
  })
}

function membershipEvent(options?: { role?: string; email?: string }) {
  const emailAddresses = options?.email ? [{ id: 'email_1', email_address: options.email }] : []
  return {
    type: 'organizationMembership.created',
    timestamp: 1_700_000_000_000,
    data: {
      role: options?.role ?? 'org:admin',
      organization: { id: 'tenant_1', name: 'Test Org', slug: 'test-org' },
      public_user_data: {
        user_id: 'user_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email_addresses: emailAddresses,
      },
    },
  }
}

describe('Clerk membership welcome webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handleClerkEvent.mockResolvedValue({
      replayed: false,
      welcomeEmailDeliveryId: 'membership_1',
    })
    mocks.isClerkWebhookReceiptConflictError.mockReturnValue(false)
    mocks.enqueueWelcomeEmail.mockResolvedValue(undefined)
  })

  it('passes the Clerk user identity only to the welcome enqueue boundary', async () => {
    const event = membershipEvent({ email: 'ada@example.com' })
    mocks.verify.mockReturnValue(event)

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.handleClerkEvent).toHaveBeenCalledWith(event, {
      providerEventId: 'msg_test',
      payloadHash: createHash('sha256').update('{}', 'utf8').digest('hex'),
    })
    expect(mocks.enqueueWelcomeEmail).toHaveBeenCalledWith(
      {
        tenantId: 'tenant_1',
        to: 'ada@example.com',
        recipientName: 'Ada Lovelace',
        orgName: 'Test Org',
      },
      'membership_1',
    )
  })

  it('does not enqueue a welcome for a non-admin membership', async () => {
    mocks.verify.mockReturnValue(membershipEvent({ role: 'org:member', email: 'ada@example.com' }))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.handleClerkEvent).toHaveBeenCalledOnce()
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
  })

  it('does not enqueue a welcome when the membership has no email', async () => {
    mocks.verify.mockReturnValue(membershipEvent())

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.handleClerkEvent).toHaveBeenCalledOnce()
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
  })

  it('returns 503 so Clerk can retry when membership synchronization fails', async () => {
    mocks.verify.mockReturnValue(membershipEvent({ email: 'ada@example.com' }))
    mocks.handleClerkEvent.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clerk.webhook.process_failed',
        eventType: 'organizationMembership.created',
        errorType: 'Error',
      }),
    )
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('database unavailable')
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('ada@example.com')
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('user_1')
  })

  it('returns 503 so Clerk can retry when welcome enqueue fails after an idempotent sync', async () => {
    mocks.verify.mockReturnValue(membershipEvent({ email: 'ada@example.com' }))
    mocks.enqueueWelcomeEmail.mockRejectedValueOnce(new Error('redis unavailable'))

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mocks.handleClerkEvent).toHaveBeenCalledOnce()
    expect(mocks.enqueueWelcomeEmail).toHaveBeenCalledOnce()
  })

  it('acknowledges a contained identity conflict so the provider does not retry forever', async () => {
    mocks.verify.mockReturnValue(membershipEvent({ email: 'ada@example.com' }))
    const conflict = new Error('receipt conflict')
    mocks.handleClerkEvent.mockRejectedValueOnce(conflict)
    mocks.isClerkWebhookReceiptConflictError.mockImplementation((error) => error === conflict)

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clerk.webhook.identity_conflict',
        eventType: 'organizationMembership.created',
      }),
    )
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('ada@example.com')
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('user_1')
  })

  it('keeps invalid signatures non-retryable', async () => {
    mocks.verify.mockImplementationOnce(() => {
      throw new Error('invalid signature')
    })

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mocks.handleClerkEvent).not.toHaveBeenCalled()
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
  })
})
