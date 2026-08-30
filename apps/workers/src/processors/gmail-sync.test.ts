import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  synchronize: vi.fn(),
  renewWatch: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    correspondenceProviderAccount: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
    },
    prospectEmailWebhookReceipt: { updateMany: mocks.updateMany },
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  publishCrmOperationalSignal: mocks.publish,
}))

vi.mock('@pathfinder/api/correspondence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/api/correspondence')>()
  return {
    ...actual,
    createGmailApiClient: vi.fn(() => ({})),
    createGmailOAuthRuntime: vi.fn(() => ({ credentials: {} })),
    createGmailCorrespondenceProvider: vi.fn(() => ({})),
    createPrismaInboundCorrespondenceStore: vi.fn(() => ({})),
    createInboundCorrespondenceService: vi.fn(() => ({
      synchronize: mocks.synchronize,
      renewWatch: mocks.renewWatch,
    })),
  }
})

import { CorrespondenceProviderError } from '@pathfinder/api/correspondence'

import { processGmailSyncJob } from './gmail-sync'

describe('Gmail sync worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
    process.env.GMAIL_OAUTH_REDIRECT_URI = 'https://example.test/callback'
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')
    process.env.GMAIL_PUBSUB_TOPIC = 'projects/test/topics/gmail'
    mocks.findUnique.mockResolvedValue({
      id: 'account-1',
      provider: 'GMAIL',
      credentialReferenceId: 'credential-1',
      connectionStatus: 'CONNECTED',
      externalAccountId: 'tom@torchiko.com',
      mailboxAddress: 'tom@torchiko.com',
    })
    mocks.publish.mockResolvedValue({ published: true })
  })

  it('marks a durable Pub/Sub receipt only after synchronization succeeds', async () => {
    mocks.synchronize.mockResolvedValue({ processed: 2 })
    await processGmailSyncJob({
      providerAccountId: 'account-1',
      trigger: 'PUBSUB_NOTIFICATION',
      receiptId: 'receipt-1',
    })
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'receipt-1' },
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    )
  })

  it('falls back to full reconciliation after an expired Gmail history cursor', async () => {
    mocks.synchronize
      .mockRejectedValueOnce(
        new CorrespondenceProviderError('HISTORY_CURSOR_EXPIRED', 'cursor expired'),
      )
      .mockResolvedValueOnce({ mode: 'FULL_RECONCILIATION' })
    await processGmailSyncJob({
      providerAccountId: 'account-1',
      trigger: 'SCHEDULED_RECONCILIATION',
    })
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: { syncCursor: null },
    })
    expect(mocks.synchronize).toHaveBeenCalledTimes(2)
  })

  it('renews watches using the configured exact Pub/Sub topic', async () => {
    mocks.renewWatch.mockResolvedValue({ cursor: '12' })
    await processGmailSyncJob({ providerAccountId: 'account-1', trigger: 'WATCH_RENEWAL' })
    expect(mocks.renewWatch).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'account-1' }),
      'projects/test/topics/gmail',
    )
  })

  it('persists only a stable failure code when provider errors contain secrets', async () => {
    const secret = 'postgres://operator:secret@example.test/torchiko'
    mocks.synchronize.mockRejectedValue(new Error(secret))

    await expect(
      processGmailSyncJob({
        providerAccountId: 'account-1',
        trigger: 'PUBSUB_NOTIFICATION',
        receiptId: 'receipt-1',
      }),
    ).rejects.toThrow(secret)

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETRYABLE',
          processingError: 'Gmail synchronization failed.',
        }),
      }),
    )
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          summary: 'Gmail synchronization failed (GMAIL_SYNC_FAILED).',
        }),
      }),
    )
    expect(JSON.stringify([mocks.updateMany.mock.calls, mocks.publish.mock.calls])).not.toContain(
      secret,
    )
  })
})
