import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('svix', () => ({
  Webhook: class {
    verify(...args: unknown[]) {
      return mocks.verify(...args)
    }
  },
}))
vi.mock('@pathfinder/db', () => ({ db: {}, withTenantIsolationBypass: vi.fn() }))

import { POST } from './route'

function request() {
  return new Request('https://app.torchiko.com/api/webhooks/resend', {
    method: 'POST',
    body: '{}',
    headers: { 'svix-id': 'event-1', 'svix-timestamp': '123', 'svix-signature': 'v1,bad' },
  })
}

describe('Resend webhook boundary', () => {
  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET
    vi.clearAllMocks()
  })

  it('is dark when the webhook secret is not configured', async () => {
    expect((await POST(request())).status).toBe(503)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('rejects an invalid signature before database access', async () => {
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_test'
    mocks.verify.mockImplementation(() => {
      throw new Error('bad signature')
    })
    expect((await POST(request())).status).toBe(400)
  })
})
