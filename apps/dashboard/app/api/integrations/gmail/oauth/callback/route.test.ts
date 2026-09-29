import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  complete: vi.fn(),
  enqueueGmailSync: vi.fn(),
  publishCrmOperationalSignal: vi.fn(),
}))

vi.mock('@pathfinder/auth/server', () => ({ auth: mocks.auth }))
vi.mock('@pathfinder/db', () => ({
  publishCrmOperationalSignal: mocks.publishCrmOperationalSignal,
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueGmailSync: mocks.enqueueGmailSync }))
vi.mock('../../../../../../lib/gmail-oauth-runtime', () => ({
  gmailOAuthRuntime: () => ({ complete: mocks.complete }),
}))

import { GET } from './route'

describe('Gmail OAuth callback redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv(
      'GMAIL_OAUTH_REDIRECT_URI',
      'https://app.torchiko.com/api/integrations/gmail/oauth/callback',
    )
    mocks.auth.mockResolvedValue({
      userId: 'admin-user',
      sessionClaims: { publicMetadata: { platform_role: 'PLATFORM_ADMIN' } },
    })
    mocks.complete.mockResolvedValue({ id: 'account-1' })
    mocks.enqueueGmailSync.mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('returns a connected result on the public app origin behind a proxy', async () => {
    const request = new NextRequest(
      'http://0.0.0.0:8080/api/integrations/gmail/oauth/callback?state=state-1&code=code-1',
    )

    const response = await GET(request)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'https://app.torchiko.com/admin/prospects/outreach?gmail=connected',
    )
    expect(mocks.complete).toHaveBeenCalledWith({
      state: 'state-1',
      code: 'code-1',
      requestedBy: 'admin-user',
    })
  })

  it('returns a failed result on the public app origin for an invalid callback', async () => {
    const request = new NextRequest('http://0.0.0.0:8080/api/integrations/gmail/oauth/callback')

    const response = await GET(request)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      'https://app.torchiko.com/admin/prospects/outreach?gmail=failed',
    )
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
