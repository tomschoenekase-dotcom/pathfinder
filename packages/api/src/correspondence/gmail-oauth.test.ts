import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attempt: null as Record<string, unknown> | null,
  credential: null as Record<string, unknown> | null,
  createAttempt: vi.fn(),
  claimAttempt: vi.fn(),
  findAttempt: vi.fn(),
  findCredential: vi.fn(),
  createCredential: vi.fn(),
  revokeCredential: vi.fn(),
  findAccount: vi.fn(),
  upsertAccount: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@pathfinder/db', () => {
  const tx = {
    correspondenceProviderAccount: {
      findUnique: mocks.findAccount,
      upsert: mocks.upsertAccount,
    },
    encryptedIntegrationCredential: {
      create: mocks.createCredential,
      updateMany: mocks.revokeCredential,
    },
  }
  return {
    db: {
      gmailOAuthAttempt: {
        create: mocks.createAttempt,
        updateMany: mocks.claimAttempt,
        findUnique: mocks.findAttempt,
      },
      encryptedIntegrationCredential: { findFirst: mocks.findCredential },
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    },
    withTenantIsolationBypass: vi.fn(async (operation: () => unknown) => operation()),
    writeAuditLogStrict: mocks.audit,
  }
})

import { createGmailOAuthRuntime } from './gmail-oauth'

const configuration = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  redirectUri: 'https://staging.example.test/api/integrations/gmail/oauth/callback',
  integrationEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
}

describe('createGmailOAuthRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.attempt = null
    mocks.credential = null
    mocks.createAttempt.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      mocks.attempt = { ...data, consumedAt: null }
      return mocks.attempt
    })
    mocks.claimAttempt.mockResolvedValue({ count: 1 })
    mocks.findAttempt.mockImplementation(() => mocks.attempt)
    mocks.findCredential.mockImplementation(() => mocks.credential)
    mocks.findAccount.mockResolvedValue(null)
    mocks.createCredential.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      mocks.credential = { ...data, revokedAt: null }
      return mocks.credential
    })
    mocks.revokeCredential.mockResolvedValue({ count: 0 })
    mocks.upsertAccount.mockResolvedValue({
      id: 'mailbox-1',
      mailboxAddress: 'outreach@torchiko.com',
      connectionStatus: 'CONNECTED',
      deliveryEnabled: false,
    })
    mocks.audit.mockResolvedValue(undefined)
  })

  it('uses one-time state, PKCE, encrypted refresh storage, and keeps delivery disabled', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.includes('oauth2.googleapis.com')) {
        return new Response(
          JSON.stringify({ access_token: 'short-access', refresh_token: 'durable-refresh' }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ emailAddress: 'outreach@torchiko.com', historyId: '100' }),
        { status: 200 },
      )
    })
    const runtime = createGmailOAuthRuntime({ configuration, fetch: transport })
    const authorization = new URL(await runtime.begin('operator-1'))
    const state = authorization.searchParams.get('state')!

    expect(authorization.searchParams.get('access_type')).toBe('offline')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/meetings.space.readonly',
      ]),
    )
    expect(authorization.searchParams.get('scope')).not.toContain('drive')
    expect(mocks.attempt).not.toHaveProperty('state', state)

    await expect(
      runtime.complete({ state, code: 'one-time-code', requestedBy: 'operator-1' }),
    ).resolves.toEqual({
      id: 'mailbox-1',
      mailboxAddress: 'outreach@torchiko.com',
      connectionStatus: 'CONNECTED',
      deliveryEnabled: false,
    })
    expect(
      Buffer.from(mocks.credential!.encryptedSecret as Uint8Array).toString('utf8'),
    ).not.toContain('durable-refresh')
    expect(mocks.upsertAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          deliveryEnabled: false,
          capabilities: expect.arrayContaining(['CALENDAR_READ', 'MEET_TRANSCRIPTS']),
        }),
        update: expect.objectContaining({ deliveryEnabled: false }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalled()
  })

  it('decrypts the refresh token only inside an access-token lease callback', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'leased-access-token' }), { status: 200 }),
      )
    const runtime = createGmailOAuthRuntime({ configuration, fetch: transport })
    const authorization = new URL(await runtime.begin('operator-1'))
    const state = authorization.searchParams.get('state')!
    const completionTransport = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2.googleapis.com')
        ? new Response(
            JSON.stringify({ access_token: 'first-access', refresh_token: 'durable-refresh' }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({ emailAddress: 'outreach@torchiko.com', historyId: '100' }),
            { status: 200 },
          ),
    )
    const completing = createGmailOAuthRuntime({ configuration, fetch: completionTransport })
    await completing.complete({ state, code: 'code', requestedBy: 'operator-1' })

    await expect(
      runtime.credentials
        .lease(String(mocks.credential!.id))
        .then((lease) => lease.withAccessToken(async (token) => token)),
    ).resolves.toBe('leased-access-token')
  })

  it('bounds and cancels a stalled OAuth token response', async () => {
    let canceled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        canceled = true
      },
    })
    const runtime = createGmailOAuthRuntime({
      configuration,
      fetch: vi.fn().mockResolvedValue(new Response(body)),
      requestTimeoutMs: 10,
    })
    const authorization = new URL(await runtime.begin('operator-1'))

    await expect(
      runtime.complete({
        state: authorization.searchParams.get('state')!,
        code: 'one-time-code',
        requestedBy: 'operator-1',
      }),
    ).rejects.toMatchObject({
      kind: 'TRANSIENT',
      message: 'Google OAuth token exchange timed out',
    })
    expect(canceled).toBe(true)
  })

  it('cancels an oversized OAuth token response before reading it', async () => {
    let canceled = false
    const body = new ReadableStream({
      cancel() {
        canceled = true
      },
    })
    const runtime = createGmailOAuthRuntime({
      configuration,
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(body, { headers: { 'content-length': String(1024 * 1024 + 1) } }),
        ),
    })
    const authorization = new URL(await runtime.begin('operator-1'))

    await expect(
      runtime.complete({
        state: authorization.searchParams.get('state')!,
        code: 'one-time-code',
        requestedBy: 'operator-1',
      }),
    ).rejects.toMatchObject({
      kind: 'PERMANENT',
      message: 'Google OAuth token exchange failed',
    })
    expect(canceled).toBe(true)
  })
})
