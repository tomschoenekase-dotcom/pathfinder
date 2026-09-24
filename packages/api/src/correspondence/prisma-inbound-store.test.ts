import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', async () => {
  const actual = await vi.importActual<typeof import('@pathfinder/db')>('@pathfinder/db')
  return {
    ...actual,
    publishCrmOperationalSignal: vi.fn().mockResolvedValue({ published: true }),
    recordProspectInboundReplyAction: vi.fn().mockResolvedValue({ activityId: 'reply-activity' }),
  }
})

import { db, publishCrmOperationalSignal, recordProspectInboundReplyAction } from '@pathfinder/db'
import { createPrismaInboundCorrespondenceStore } from './prisma-inbound-store'
import { SyncCursorConflictError } from './inbound-sync'
import { normalizeUntrustedCorrespondenceBody } from './content-safety'

const mailbox = {
  provider: 'GMAIL' as const,
  providerAccountId: 'account-1',
  mailboxId: 'mailbox-1',
  mailboxAddress: 'outreach@example.test',
  credentialRef: 'opaque-test-reference',
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(publishCrmOperationalSignal).mockResolvedValue({ published: true } as never)
  vi.mocked(recordProspectInboundReplyAction).mockResolvedValue({
    activityId: 'reply-activity',
  } as never)
})

describe('Prisma inbound correspondence store', () => {
  it('binds a receipt event ID to one exact message reference', async () => {
    vi.spyOn(db.correspondenceProviderAccount, 'findUnique').mockResolvedValue({
      id: mailbox.providerAccountId,
      provider: 'GMAIL',
      externalAccountId: mailbox.mailboxId,
    } as never)
    vi.spyOn(db.prospectEmailWebhookReceipt, 'findUnique').mockResolvedValue({
      id: 'existing-receipt',
      provider: 'GMAIL',
      providerAccountId: mailbox.providerAccountId,
      providerMailboxKey: mailbox.mailboxId,
      providerEventId: 'event-1',
      payload: { messageExternalId: 'original-message' },
      status: 'PROCESSED',
      attemptCount: 1,
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
    } as never)
    const create = vi.spyOn(db.prospectEmailWebhookReceipt, 'create')
    const store = createPrismaInboundCorrespondenceStore()

    await expect(
      store.receiveReceipt({
        provider: 'GMAIL',
        providerAccountId: mailbox.providerAccountId,
        mailboxId: mailbox.mailboxId,
        externalReceiptId: 'event-1',
        messageExternalId: 'different-message',
        receivedAt: new Date('2026-09-22T00:00:01.000Z'),
      }),
    ).rejects.toThrow('conflicts with its exact message reference')
    expect(create).not.toHaveBeenCalled()
  })

  it('does not let an older failed attempt overwrite a newer processed receipt', async () => {
    const updateMany = vi
      .spyOn(db.prospectEmailWebhookReceipt, 'updateMany')
      .mockResolvedValue({ count: 0 } as never)
    vi.spyOn(db.prospectEmailWebhookReceipt, 'findUniqueOrThrow').mockResolvedValue({
      id: 'receipt-1',
      provider: 'GMAIL',
      providerAccountId: mailbox.providerAccountId,
      providerMailboxKey: mailbox.mailboxId,
      providerEventId: 'event-1',
      status: 'PROCESSED',
      attemptCount: 2,
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
    } as never)
    const store = createPrismaInboundCorrespondenceStore()

    await expect(
      store.markReceiptState({
        receiptId: 'receipt-1',
        attemptCount: 1,
        state: 'RETRYABLE_FAILURE',
      }),
    ).resolves.toMatchObject({ applied: false, receipt: { state: 'PROCESSED' } })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'receipt-1', status: 'PROCESSING', attemptCount: 1 },
      }),
    )
  })

  it('claims a bounded receipt lease and returns its new attempt generation', async () => {
    const claimedAt = new Date('2026-09-22T00:00:00.000Z')
    const leaseUntil = new Date('2026-09-22T00:05:00.000Z')
    const updateMany = vi
      .spyOn(db.prospectEmailWebhookReceipt, 'updateMany')
      .mockResolvedValue({ count: 1 } as never)
    vi.spyOn(db.prospectEmailWebhookReceipt, 'findUniqueOrThrow').mockResolvedValue({
      id: 'receipt-1',
      provider: 'GMAIL',
      providerAccountId: mailbox.providerAccountId,
      providerMailboxKey: mailbox.mailboxId,
      providerEventId: 'event-1',
      status: 'PROCESSING',
      attemptCount: 3,
      nextAttemptAt: leaseUntil,
      createdAt: claimedAt,
    } as never)
    const store = createPrismaInboundCorrespondenceStore()

    await expect(store.claimReceipt('receipt-1', claimedAt)).resolves.toMatchObject({
      claimed: true,
      receipt: { state: 'PROCESSING', attemptCount: 3 },
    })
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'receipt-1', OR: expect.any(Array) }),
        data: expect.objectContaining({
          status: 'PROCESSING',
          attemptCount: { increment: 1 },
          nextAttemptAt: leaseUntil,
        }),
      }),
    )
  })

  it('publishes one reply signal across failed publication, retry, and replay', async () => {
    vi.spyOn(db, '$transaction').mockImplementation((async (
      callback: (client: typeof db) => Promise<unknown>,
    ) => callback(db)) as never)
    vi.spyOn(db.correspondenceProviderAccount, 'findUniqueOrThrow').mockResolvedValue({
      provider: 'FAKE',
    } as never)
    const marker = {
      emailMessageId: 'canonical-message-1',
      eventType: 'crm.reply_received.signal',
    }
    const findMarker = vi
      .spyOn(db.prospectEmailEvent, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(marker as never)
    const createMarker = vi
      .spyOn(db.prospectEmailEvent, 'create')
      .mockResolvedValue({ id: 'marker-1' } as never)
    const publish = vi.mocked(publishCrmOperationalSignal)
    publish.mockRejectedValueOnce(new Error('signal unavailable'))
    publish.mockResolvedValue({ published: true } as never)
    const store = createPrismaInboundCorrespondenceStore()
    const input = {
      canonicalMessageId: 'canonical-message-1',
      canonicalThreadId: 'canonical-thread-1',
      providerAccountId: mailbox.providerAccountId,
      prospectOrganizationId: 'organization-1',
      contactId: null,
      campaignMemberId: null,
      occurredAt: new Date('2026-09-22T00:00:00.000Z'),
      matchingEvidence: ['PROVIDER_THREAD'] as const,
    }

    await expect(store.appendRelationshipReply(input)).rejects.toThrow('signal unavailable')
    expect(createMarker).not.toHaveBeenCalled()
    await store.appendRelationshipReply(input)
    await store.appendRelationshipReply(input)
    expect(findMarker).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          summary: expect.stringContaining('SYNTHETIC FAKE-provider reply'),
        }),
      }),
    )
    expect(createMarker).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordProspectInboundReplyAction)).toHaveBeenCalledTimes(3)
    expect(createMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailMessageId: input.canonicalMessageId,
          providerAccountId: input.providerAccountId,
        }),
      }),
    )
  })

  it('reads back a concurrent receipt insert by exact provider identity', async () => {
    vi.spyOn(db.correspondenceProviderAccount, 'findUnique').mockResolvedValue({
      id: mailbox.providerAccountId,
      provider: 'GMAIL',
      externalAccountId: mailbox.mailboxId,
    } as never)
    const findReceipt = vi
      .spyOn(db.prospectEmailWebhookReceipt, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'winning-receipt',
        providerAccountId: mailbox.providerAccountId,
        provider: 'GMAIL',
        providerMailboxKey: mailbox.mailboxId,
        providerEventId: 'exact-event',
        payload: { mailboxId: mailbox.mailboxId, messageExternalId: 'message-1' },
        status: 'PROCESSED',
        attemptCount: 1,
        createdAt: new Date('2026-09-22T00:00:00.000Z'),
      } as never)
    vi.spyOn(db.prospectEmailWebhookReceipt, 'create').mockRejectedValue({ code: 'P2002' })
    const store = createPrismaInboundCorrespondenceStore()

    await expect(
      store.receiveReceipt({
        provider: 'GMAIL',
        providerAccountId: mailbox.providerAccountId,
        mailboxId: mailbox.mailboxId,
        externalReceiptId: 'exact-event',
        messageExternalId: 'message-1',
        receivedAt: new Date('2026-09-22T00:00:01.000Z'),
      }),
    ).resolves.toMatchObject({
      inserted: false,
      receipt: { id: 'winning-receipt', state: 'PROCESSED' },
    })
    expect(findReceipt).toHaveBeenCalledTimes(2)
  })

  it('commits only if the account still owns the cursor and mailbox', async () => {
    const updateMany = vi
      .spyOn(db.correspondenceProviderAccount, 'updateMany')
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 0 } as never)
    const store = createPrismaInboundCorrespondenceStore()
    const input = {
      mailbox,
      expectedCursor: 'old-history',
      cursor: 'new-history',
      mode: 'INCREMENTAL' as const,
      completedAt: new Date('2026-09-22T00:00:00.000Z'),
    }

    await expect(store.commitSyncCursor(input)).resolves.toBeUndefined()
    await expect(store.commitSyncCursor(input)).rejects.toThrow(SyncCursorConflictError)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: mailbox.providerAccountId,
          provider: 'GMAIL',
          externalAccountId: mailbox.mailboxId,
          syncCursor: 'old-history',
        }),
      }),
    )
  })

  it('clears only the expired cursor observed by the current run', async () => {
    const updateMany = vi
      .spyOn(db.correspondenceProviderAccount, 'updateMany')
      .mockResolvedValueOnce({ count: 0 } as never)
    const store = createPrismaInboundCorrespondenceStore()

    await expect(
      store.clearExpiredSyncCursor({ mailbox, expectedCursor: 'expired-history' }),
    ).rejects.toThrow(SyncCursorConflictError)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ syncCursor: 'expired-history' }),
        data: { syncCursor: null },
      }),
    )
  })

  it('renews a watch without advancing the ingestion cursor', async () => {
    const update = vi
      .spyOn(db.correspondenceProviderAccount, 'update')
      .mockResolvedValue({} as never)
    const store = createPrismaInboundCorrespondenceStore()

    await store.saveWatch({
      mailbox,
      watch: {
        provider: 'GMAIL',
        mailboxId: mailbox.mailboxId,
        cursor: 'provider-watch-cursor',
        expiresAt: new Date('2026-09-22T00:00:00.000Z'),
      },
      renewedAt: new Date('2026-09-21T23:00:00.000Z'),
    })

    expect(update).toHaveBeenCalledWith({
      where: { id: mailbox.providerAccountId },
      data: { watchExpiration: new Date('2026-09-22T00:00:00.000Z') },
    })
  })

  it('converges a publish failure and concurrent P2002 retry to one quarantine identity', async () => {
    const create = vi
      .spyOn(db.prospectInboundQuarantine, 'create')
      .mockResolvedValueOnce({ id: 'inbound-quarantine-test' } as never)
      .mockRejectedValueOnce({ code: 'P2002' })
    const publish = vi.mocked(publishCrmOperationalSignal)
    publish.mockRejectedValueOnce(new Error('signal temporarily unavailable'))
    publish.mockResolvedValueOnce({ published: true } as never)
    const store = createPrismaInboundCorrespondenceStore()

    const input = {
      receiptId: 'receipt-1',
      reason: 'PROVIDER_MESSAGE_NOT_FOUND' as const,
      message: null,
      occurredAt: new Date('2026-09-21T23:00:00.000Z'),
    }
    await expect(store.quarantine(input)).rejects.toThrow('signal temporarily unavailable')
    await expect(store.quarantine(input)).resolves.toBeUndefined()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: expect.stringMatching(/^inbound-quarantine-[0-9a-f]{40}$/u),
          receiptId: 'receipt-1',
          providerAccountId: null,
        }),
      }),
    )
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]![0].data.id).toBe(create.mock.calls[1]![0].data.id)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          signal: 'gmail_sync_failed',
          linkedObjectType: 'ProspectInboundQuarantine',
          summary: 'Inbound provider content was quarantined: PROVIDER_MESSAGE_NOT_FOUND.',
        }),
      }),
    )
  })

  it('reuses one quarantine identity for replayed unmatched provider messages', async () => {
    const create = vi
      .spyOn(db.prospectInboundQuarantine, 'create')
      .mockResolvedValueOnce({ id: 'created' } as never)
      .mockRejectedValueOnce({ code: 'P2002' })
    vi.spyOn(db.correspondenceProviderAccount, 'findUnique').mockResolvedValue({
      provider: 'GMAIL',
      externalAccountId: mailbox.mailboxId,
    } as never)
    const store = createPrismaInboundCorrespondenceStore()
    const message = {
      message: { ...mailbox, externalId: 'inbound-1' },
      thread: { ...mailbox, externalId: 'thread-1' },
      rfcMessageId: '<inbound-1@example.test>',
      inReplyTo: null,
      references: [],
      from: [{ email: 'person@example.test' }],
      to: [{ email: mailbox.mailboxAddress }],
      cc: [],
      bcc: [],
      subject: 'Reply',
      internalDate: new Date('2026-09-22T00:00:00.000Z'),
      direction: 'INBOUND' as const,
      body: normalizeUntrustedCorrespondenceBody({ text: 'Hello' }),
      attachments: [],
    }
    const input = {
      receiptId: null,
      reason: 'UNKNOWN_THREAD' as const,
      message,
      occurredAt: new Date('2026-09-22T00:00:01.000Z'),
    }

    await store.quarantine(input)
    await store.quarantine(input)
    expect(create.mock.calls[0]![0].data.id).toBe(create.mock.calls[1]![0].data.id)
    expect(create.mock.calls[0]![0].data.id).toMatch(/^inbound-quarantine-[0-9a-f]{40}$/u)
    expect(vi.mocked(publishCrmOperationalSignal)).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          summary: 'Inbound Gmail content was quarantined: UNKNOWN_THREAD.',
        }),
      }),
    )
  })

  it('labels only a scoped FAKE account message as synthetic in quarantine signals', async () => {
    vi.spyOn(db.prospectInboundQuarantine, 'create').mockResolvedValue({
      id: 'fake-quarantine',
    } as never)
    const account = vi.spyOn(db.correspondenceProviderAccount, 'findUnique').mockResolvedValue({
      provider: 'FAKE',
      externalAccountId: 'SYN-FAKE-mailbox',
    } as never)
    const ref = {
      provider: 'FAKE' as const,
      providerAccountId: 'fake-account',
      mailboxId: 'SYN-FAKE-mailbox',
      externalId: 'fake-message',
    }
    const store = createPrismaInboundCorrespondenceStore()
    const input = {
      receiptId: null,
      reason: 'UNKNOWN_THREAD' as const,
      message: {
        message: ref,
        thread: { ...ref, externalId: 'fake-thread' },
        rfcMessageId: '<fake@example.invalid>',
        inReplyTo: null,
        references: [],
        from: [{ email: 'contact@example.invalid' }],
        to: [{ email: 'mailbox@example.invalid' }],
        cc: [],
        bcc: [],
        subject: 'Synthetic reply',
        internalDate: new Date('2026-09-22T00:00:00.000Z'),
        direction: 'INBOUND' as const,
        body: normalizeUntrustedCorrespondenceBody({ text: 'Synthetic body' }),
        attachments: [],
      },
      occurredAt: new Date('2026-09-22T00:00:01.000Z'),
    }

    await store.quarantine(input)
    expect(account).toHaveBeenCalledWith({
      where: { id: ref.providerAccountId },
      select: { provider: true, externalAccountId: true },
    })
    expect(vi.mocked(publishCrmOperationalSignal)).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          signal: 'gmail_sync_failed',
          linkedObjectId: 'fake-quarantine',
          summary: 'Inbound SYNTHETIC FAKE-provider content was quarantined: UNKNOWN_THREAD.',
        }),
      }),
    )

    account.mockResolvedValue({
      provider: 'GMAIL',
      externalAccountId: 'different-mailbox',
    } as never)
    await store.quarantine(input)
    expect(vi.mocked(publishCrmOperationalSignal)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          summary: 'Inbound provider content was quarantined: UNKNOWN_THREAD.',
        }),
      }),
    )
  })

  it('propagates unrelated quarantine persistence failures', async () => {
    const create = vi
      .spyOn(db.prospectInboundQuarantine, 'create')
      .mockRejectedValue(new Error('database unavailable'))
    const store = createPrismaInboundCorrespondenceStore()

    await expect(
      store.quarantine({
        receiptId: 'receipt-2',
        reason: 'PROVIDER_MESSAGE_NOT_FOUND',
        message: null,
        occurredAt: new Date('2026-09-21T23:00:00.000Z'),
      }),
    ).rejects.toThrow('database unavailable')
    expect(create).toHaveBeenCalledOnce()
  })
})
