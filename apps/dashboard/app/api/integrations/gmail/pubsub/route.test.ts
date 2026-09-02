import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verifyGooglePubSubPush: vi.fn(),
  parseGmailPushEnvelope: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  publishCrmOperationalSignal: vi.fn(),
  enqueueGmailSync: vi.fn(),
}))

vi.mock('@pathfinder/api/correspondence', () => ({
  verifyGooglePubSubPush: mocks.verifyGooglePubSubPush,
  parseGmailPushEnvelope: mocks.parseGmailPushEnvelope,
}))
vi.mock('@pathfinder/db', () => ({
  db: {},
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  publishCrmOperationalSignal: mocks.publishCrmOperationalSignal,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueGmailSync: mocks.enqueueGmailSync }))

import { POST } from './route'

describe('Gmail Pub/Sub request boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv(
      'GMAIL_PUBSUB_PUSH_AUDIENCE',
      'https://dashboard.example/api/integrations/gmail/pubsub',
    )
    vi.stubEnv('GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT', 'push@example.iam.gserviceaccount.com')
    mocks.verifyGooglePubSubPush.mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('rejects an oversized authenticated notification before parsing or database work', async () => {
    const request = new NextRequest('https://dashboard.example/api/integrations/gmail/pubsub', {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Notification too large' })
    expect(mocks.verifyGooglePubSubPush).toHaveBeenCalledOnce()
    expect(mocks.parseGmailPushEnvelope).not.toHaveBeenCalled()
    expect(mocks.withTenantIsolationBypass).not.toHaveBeenCalled()
  })

  it('contains an invalid declared length as an invalid notification', async () => {
    const request = new NextRequest('https://dashboard.example/api/integrations/gmail/pubsub', {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        'content-length': 'private-provider-detail',
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid notification' })
    expect(mocks.parseGmailPushEnvelope).not.toHaveBeenCalled()
    expect(mocks.withTenantIsolationBypass).not.toHaveBeenCalled()
  })
})
