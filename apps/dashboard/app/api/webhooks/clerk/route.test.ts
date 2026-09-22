import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  getClerkMembershipEmail: (publicUserData: {
    email_addresses?: Array<{ email_address: string }>
    identifier?: string
  }) => publicUserData.email_addresses?.[0]?.email_address ?? publicUserData.identifier,
  handleClerkEvent: mocks.handleClerkEvent,
  isClerkWebhookReceiptConflictError: mocks.isClerkWebhookReceiptConflictError,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueWelcomeEmail: mocks.enqueueWelcomeEmail }))

import { POST } from './route'

describe('production identity binding on verified webhooks', () => {
  const museums = [
    ['org_newMiniature', 'org_3HN2BNDTxN9EU5HrfMOh9gWIxao'],
    ['org_newSpace', 'org_3HV2vyn6xVr0wPRx2PAmC6AH7V2'],
  ] as const
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv(
      'CLERK_IDENTITY_BINDING',
      JSON.stringify({
        version: 1,
        issuer: 'https://clerk.synthetic.example',
        instanceId: 'ins_synthetic',
        webhookSecretSha256: createHash('sha256').update('test-webhook-secret').digest('hex'),
        users: [{ providerId: 'user_newTom', applicationId: 'user_oldTom' }],
        organizations: museums.map(([providerId, applicationId]) => ({
          providerId,
          applicationId,
        })),
      }),
    )
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_synthetic')
    const key = `pk_live_${Buffer.from('clerk.synthetic.example$').toString('base64')}`
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', key)
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', key)
    mocks.handleClerkEvent.mockResolvedValue({ replayed: false, welcomeEmailDeliveryId: null })
    mocks.isClerkWebhookReceiptConflictError.mockReturnValue(false)
  })
  afterEach(() => vi.unstubAllEnvs())
  it.each(museums)(
    'persists canonical IDs for %s while preserving raw replay identity',
    async (providerId, applicationId) => {
      const original = { ...membershipEvent(), instance_id: 'ins_synthetic' }
      original.data.organization.id = providerId
      original.data.public_user_data.user_id = 'user_newTom'
      mocks.verify.mockReturnValue(original)
      const body = JSON.stringify(original)
      const identity = {
        providerEventId: 'msg_test',
        payloadHash: createHash('sha256').update(body).digest('hex'),
      }
      expect((await POST(signedRequest(body))).status).toBe(200)
      expect(mocks.handleClerkEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization: expect.objectContaining({ id: applicationId }),
            public_user_data: expect.objectContaining({ user_id: 'user_oldTom' }),
          }),
        }),
        identity,
      )
      mocks.handleClerkEvent.mockResolvedValue({ replayed: true, welcomeEmailDeliveryId: null })
      expect((await POST(signedRequest(body))).status).toBe(200)
      expect(mocks.handleClerkEvent.mock.calls[1]?.[1]).toEqual(identity)
      expect(original.data.organization.id).toBe(providerId)
      expect(original.data.public_user_data.user_id).toBe('user_newTom')
      expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
    },
  )
  it.each(['organizationMembership.updated', 'organizationMembership.deleted'])(
    'translates %s without changing event order or role',
    async (type) => {
      const original = {
        ...membershipEvent({ role: 'org:member' }),
        type,
        instance_id: 'ins_synthetic',
      }
      original.data.organization.id = museums[1][0]
      original.data.public_user_data.user_id = 'user_newTom'
      mocks.verify.mockReturnValue(original)
      expect((await POST(signedRequest(JSON.stringify(original)))).status).toBe(200)
      expect(mocks.handleClerkEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type,
          timestamp: original.timestamp,
          data: expect.objectContaining({
            role: 'org:member',
            organization: expect.objectContaining({ id: museums[1][1] }),
            public_user_data: expect.objectContaining({ user_id: 'user_oldTom' }),
          }),
        }),
        expect.any(Object),
      )
    },
  )
  it('maps organization creation to the existing tenant and keeps new organizations distinct', async () => {
    for (const id of [museums[0][0], 'org_newCustomer']) {
      mocks.verify.mockReturnValue({
        type: 'organization.created',
        instance_id: 'ins_synthetic',
        timestamp: 1,
        data: { id, name: 'Synthetic', slug: 'synthetic' },
      })
      expect((await POST(request())).status).toBe(200)
      expect(mocks.handleClerkEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: {
            id: id === museums[0][0] ? museums[0][1] : id,
            name: 'Synthetic',
            slug: 'synthetic',
          },
        }),
        expect.any(Object),
      )
    }
  })
  it.each([
    { instance_id: 'ins_wrong', userId: 'user_newTom' },
    { instance_id: 'ins_synthetic', userId: 'user_oldTom' },
  ])(
    'refuses verified but wrong-instance or retired-ID events %#',
    async ({ instance_id, userId }) => {
      const event = { ...membershipEvent(), instance_id }
      event.data.organization.id = museums[0][0]
      event.data.public_user_data.user_id = userId
      mocks.verify.mockReturnValue(event)
      expect((await POST(request())).status).toBe(503)
      expect(mocks.handleClerkEvent).not.toHaveBeenCalled()
      expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
    },
  )
})

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

function signedRequest(body: BodyInit, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://dashboard.example/api/webhooks/clerk', {
    method: 'POST',
    body,
    headers: {
      'svix-id': 'msg_test',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,test',
      ...extraHeaders,
    },
    ...(!(typeof body === 'string') ? ({ duplex: 'half' } as { duplex: 'half' }) : {}),
  })
}

function membershipEvent(options?: { role?: string; email?: string; identifier?: string }) {
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
        ...(options?.identifier ? { identifier: options.identifier } : {}),
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

  it('uses Clerk current identifier payloads for the welcome recipient', async () => {
    mocks.verify.mockReturnValue(membershipEvent({ identifier: 'ada@example.com' }))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.enqueueWelcomeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@example.com' }),
      'membership_1',
    )
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

  it('rejects invalid signatures without processing the event', async () => {
    mocks.verify.mockImplementationOnce(() => {
      throw new Error('invalid signature')
    })

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mocks.handleClerkEvent).not.toHaveBeenCalled()
    expect(mocks.enqueueWelcomeEmail).not.toHaveBeenCalled()
  })

  it('rejects missing signature headers before consuming the request body', async () => {
    let bodyAccessed = false
    const unsigned = {
      headers: new Headers(),
      get body() {
        bodyAccessed = true
        throw new Error('unsigned body must not be accessed')
      },
    } as unknown as Request

    const response = await POST(unsigned)

    expect(response.status).toBe(401)
    expect(bodyAccessed).toBe(false)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('rejects an oversized declared body before signature verification', async () => {
    const response = await POST(signedRequest('{}', { 'content-length': String(256 * 1024 + 1) }))

    expect(response.status).toBe(413)
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.handleClerkEvent).not.toHaveBeenCalled()
  })

  it('rejects a malformed declared length before signature verification', async () => {
    const response = await POST(signedRequest('{}', { 'content-length': '12x' }))

    expect(response.status).toBe(400)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('cancels a streamed body as soon as it exceeds the pre-auth byte ceiling', async () => {
    let cancelled = false
    let emitted = 0
    const body = new ReadableStream({
      pull(controller) {
        emitted += 1
        controller.enqueue(new Uint8Array(128 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })

    const response = await POST(signedRequest(body))

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(emitted).toBeLessThan(6)
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.handleClerkEvent).not.toHaveBeenCalled()
  })

  it('cancels an aborted body read before signature verification', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancel = vi.fn().mockResolvedValue(undefined)
    const stalled = {
      headers: new Headers({
        'svix-id': 'msg_test',
        'svix-timestamp': '1234567890',
        'svix-signature': 'v1,test',
      }),
      signal: controller.signal,
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel,
        }),
      },
    } as unknown as Request

    const response = await POST(stalled)

    expect(response.status).toBe(408)
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('rejects invalid UTF-8 before signature verification', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]))
        controller.close()
      },
    })

    const response = await POST(signedRequest(body))

    expect(response.status).toBe(400)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('preserves the exact raw body at the byte ceiling for signature verification', async () => {
    const body = 'x'.repeat(256 * 1024)
    mocks.verify.mockReturnValue(membershipEvent())

    const response = await POST(signedRequest(body))

    expect(response.status).toBe(200)
    expect(mocks.verify).toHaveBeenCalledWith(body, {
      'svix-id': 'msg_test',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,test',
    })
  })
})
