import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  synchronize: vi.fn(),
  renewWatch: vi.fn(),
  publish: vi.fn(),
  enqueue: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  updateJobPayload: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    correspondenceProviderAccount: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
    },
    prospectEmailWebhookReceipt: { updateMany: mocks.updateMany },
    jobRecord: { update: mocks.updateJobPayload },
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  publishCrmOperationalSignal: mocks.publish,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueGmailSync: mocks.enqueue,
  GMAIL_SYNC_QUEUE: 'gmail-sync',
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
      lastReconciliationAt: null,
    })
    mocks.publish.mockResolvedValue({ published: true })
    mocks.enqueue.mockResolvedValue('gmail-sync-continuation')
    mocks.writeJobRecord.mockResolvedValue('job-record-1')
  })

  it('marks a durable Pub/Sub receipt only after synchronization succeeds', async () => {
    mocks.synchronize.mockResolvedValue({ processed: 2, complete: true })
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

  it.each(['missing credential', 'missing runtime configuration'])(
    'marks a durable Pub/Sub receipt retryable when setup fails: %s',
    async (failure) => {
      if (failure === 'missing credential') {
        mocks.findUnique.mockResolvedValueOnce({
          id: 'account-1',
          provider: 'GMAIL',
          credentialReferenceId: null,
          connectionStatus: 'CONNECTED',
        })
      } else {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID
      }
      await expect(
        processGmailSyncJob({
          providerAccountId: 'account-1',
          trigger: 'PUBSUB_NOTIFICATION',
          receiptId: 'receipt-1',
        }),
      ).rejects.toThrow()
      expect(mocks.synchronize).not.toHaveBeenCalled()
      expect(mocks.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'receipt-1' },
          data: expect.objectContaining({
            status: 'RETRYABLE',
            processingError: 'Gmail synchronization failed.',
          }),
        }),
      )
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            signal: 'gmail_sync_failed',
            linkedObjectId: 'account-1',
            summary: 'Gmail synchronization failed (GMAIL_SYNC_FAILED).',
          }),
        }),
      )
    },
  )

  it('falls back to full reconciliation after an expired Gmail history cursor', async () => {
    mocks.synchronize
      .mockRejectedValueOnce(
        new CorrespondenceProviderError('HISTORY_CURSOR_EXPIRED', 'cursor expired'),
      )
      .mockResolvedValueOnce({ mode: 'FULL_RECONCILIATION', complete: true })
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

  it('reconciles a bounded page and queues its continuation before acknowledging a push receipt', async () => {
    mocks.synchronize.mockResolvedValue({
      mode: 'FULL_RECONCILIATION',
      processed: 100,
      complete: false,
      nextPageToken: 'page-2',
      baselineCursor: null,
      targetCursor: 'target-head',
    })
    await processGmailSyncJob({
      providerAccountId: 'account-1',
      trigger: 'PUBSUB_NOTIFICATION',
      receiptId: 'receipt-1',
    })
    expect(mocks.enqueue).toHaveBeenCalledWith({
      providerAccountId: 'account-1',
      trigger: 'PUBSUB_NOTIFICATION',
      receiptId: 'receipt-1',
      pageToken: 'page-2',
      after: new Date(0).toISOString(),
      baselineCursor: null,
      mode: 'FULL_RECONCILIATION',
      targetCursor: 'target-head',
    })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('records a safe durable job result by the exact queue identity', async () => {
    mocks.synchronize.mockResolvedValue({
      mode: 'FULL_RECONCILIATION',
      processed: 4,
      complete: true,
      cursor: 'new-cursor',
    })
    await processGmailSyncJob(
      { providerAccountId: 'account-1', trigger: 'SCHEDULED_RECONCILIATION' },
      { bullJobId: 'gmail-sync-a', attemptNumber: 1, maxAttempts: 8 },
    )
    expect(mocks.synchronize).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'account-1' }),
      { mode: 'FULL_RECONCILIATION', after: new Date(0) },
    )
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'gmail-sync', bullJobId: 'gmail-sync-a' }),
    )
    expect(mocks.updateJobPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-record-1' },
        data: { payload: expect.objectContaining({ processed: 4, complete: true }) },
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job-record-1', { status: 'COMPLETE' })
  })

  it('uses a stable 24-hour overlap for scheduled reconciliation after an earlier completed run', async () => {
    const lastReconciliationAt = new Date('2026-10-02T12:00:00Z')
    mocks.findUnique.mockResolvedValueOnce({
      id: 'account-1',
      provider: 'GMAIL',
      credentialReferenceId: 'credential-1',
      connectionStatus: 'CONNECTED',
      externalAccountId: 'example@example.test',
      mailboxAddress: 'example@example.test',
      lastReconciliationAt,
    })
    mocks.synchronize.mockResolvedValue({ mode: 'FULL_RECONCILIATION', complete: true })
    await processGmailSyncJob({
      providerAccountId: 'account-1',
      trigger: 'SCHEDULED_RECONCILIATION',
    })
    expect(mocks.synchronize).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: 'account-1' }),
      { mode: 'FULL_RECONCILIATION', after: new Date('2026-10-01T12:00:00Z') },
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
