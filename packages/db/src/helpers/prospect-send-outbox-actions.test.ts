import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { launchAttachmentsSha256 } from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'

const attachmentMocks = vi.hoisted(() => ({ current: vi.fn() }))
vi.mock('./prospect-launch-attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prospect-launch-attachments')>()
  return { ...actual, requireCurrentProspectLaunchAttachments: attachmentMocks.current }
})

import {
  claimProspectSendOutboxAction,
  foldProspectEmailStatus,
  recordProspectSendFailureAction,
  revalidateProspectSendOutboxClaimAction,
} from './prospect-send-outbox-actions'
import { prospectOperationalContentHash } from './prospect-launch-attachments'

const qrUrl = 'https://guide.example.com/venue/chat?source=qr'
const qrBytes = Buffer.from(renderVenueQrSvg(qrUrl), 'utf8')
const frozenAsset: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  release: { kind: 'LEGACY', id: 'legacy:venue-1', revisionSha256: 'a'.repeat(64) },
  publicUrl: qrUrl,
  filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: qrBytes.length,
  sha256: createHash('sha256').update(qrBytes).digest('hex'),
  contentBase64: qrBytes.toString('base64'),
}
const pdfBytes = Buffer.from('%PDF-1.4 frozen fixture')
const frozenPdfAsset: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/2',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  release: { kind: 'LEGACY', id: 'legacy:venue-1', revisionSha256: 'a'.repeat(64) },
  publicUrl: qrUrl,
  format: 'PDF',
  generatorVersion: 'qr-print-v1',
  filename: 'venue-qr.pdf',
  mimeType: 'application/pdf',
  sizeBytes: pdfBytes.length,
  sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  contentBase64: pdfBytes.toString('base64'),
}
describe('prospect provider event folding', () => {
  it.each([
    ['DELIVERED', 'SENT', 'DELIVERED'],
    ['BOUNCED', 'DELIVERED', 'BOUNCED'],
    ['COMPLAINED', 'SENT', 'COMPLAINED'],
    ['SUPPRESSED', 'DELIVERED', 'SUPPRESSED'],
    ['QUEUED', 'SENT', 'SENT'],
  ] as const)('folds %s then %s to %s', (current, incoming, expected) => {
    expect(foldProspectEmailStatus(current, incoming)).toBe(expected)
  })
})

describe('prospect last-mile delivery authority', () => {
  it.each([null, { id: 'reply-1' }])(
    'refuses dispatch and terminal mutation when the lease expires during reply lookup (%j)',
    async (reply) => {
      vi.useFakeTimers()
      const startedAt = new Date('2026-08-22T16:00:00.000Z')
      const expiresAt = new Date(startedAt.valueOf() + 1_000)
      vi.setSystemTime(startedAt)
      const email = 'recipient@example.test'
      const tx = {
        prospectDeliveryControl: {
          findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true, internalOnly: false }),
        },
        prospectSendOutbox: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'outbox-1',
            status: 'CLAIMED',
            claimOwner: 'worker-1',
            claimExpiresAt: expiresAt,
            attemptCount: 1,
            providerAccount: {
              provider: 'GMAIL',
              capabilities: ['SEND'],
              deliveryEnabled: true,
              pausedAt: null,
              connectionStatus: 'CONNECTED',
            },
            sendItem: {
              id: 'item-1',
              createdAt: startedAt,
              recipientEmailSnapshot: email,
              recipientIdentityHash: createHash('sha256').update(email).digest('hex'),
              member: {
                id: 'member-1',
                organizationId: 'org-1',
                contactId: 'contact-1',
                status: 'QUEUED',
                contact: {
                  normalizedEmail: email,
                  emailReadiness: 'VALID',
                  permissionState: 'UNKNOWN',
                },
              },
              batch: { campaign: { pausedAt: null, status: 'ACTIVE' } },
            },
          }),
          updateMany: vi.fn(),
        },
        prospectSendItem: { update: vi.fn() },
        prospectEmailMessage: {
          findFirst: vi.fn().mockImplementation(async () => {
            vi.setSystemTime(expiresAt)
            return reply
          }),
        },
      }
      try {
        await expect(
          revalidateProspectSendOutboxClaimAction({ outboxId: 'outbox-1', workerId: 'worker-1' }, {
            $transaction: vi.fn((work) => work(tx)),
          } as never),
        ).resolves.toBe(false)
        expect(tx.prospectEmailMessage.findFirst).toHaveBeenCalledOnce()
        expect(tx.prospectSendOutbox.updateMany).not.toHaveBeenCalled()
        expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('cancels a claimed operation when the emergency stop changed after claim', async () => {
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: false }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-1',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
          providerAccount: {
            provider: 'GMAIL',
            capabilities: ['SEND'],
            deliveryEnabled: true,
            pausedAt: null,
            connectionStatus: 'CONNECTED',
          },
          sendItem: { id: 'item-1', batch: { campaign: { pausedAt: null, status: 'ACTIVE' } } },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
      prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER',
        }),
      }),
    )
  })

  it('rejects an expired or stolen claim without mutating its new owner', async () => {
    const tx = {
      prospectDeliveryControl: { findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }) },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-2',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).not.toHaveBeenCalled()
  })

  it('cancels a claimed operation when the internal allowlist tightened after release', async () => {
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: ['reviewer@torchiko.test'],
        }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-1',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
          providerAccount: {
            provider: 'GMAIL',
            capabilities: ['SEND'],
            deliveryEnabled: true,
            pausedAt: null,
            connectionStatus: 'CONNECTED',
          },
          sendItem: {
            id: 'item-1',
            recipientEmailSnapshot: 'removed@torchiko.test',
            batch: { campaign: { pausedAt: null, status: 'ACTIVE' } },
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER',
        }),
      }),
    )
  })

  it('retains a claimed operation for an exact case-insensitive internal allowlist match', async () => {
    const normalizedEmail = 'reviewer@torchiko.test'
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: ['Reviewer@Torchiko.Test'],
        }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-1',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
          providerAccount: {
            provider: 'GMAIL',
            capabilities: ['SEND'],
            deliveryEnabled: true,
            pausedAt: null,
            connectionStatus: 'CONNECTED',
          },
          sendItem: {
            id: 'item-1',
            recipientEmailSnapshot: normalizedEmail,
            recipientIdentityHash: createHash('sha256').update(normalizedEmail).digest('hex'),
            member: {
              contact: {
                normalizedEmail,
                archivedAt: null,
                doNotContact: false,
                emailReadiness: 'VALID',
                permissionState: 'UNKNOWN',
                suppressedAt: null,
                unsubscribedAt: null,
              },
            },
            batch: { campaign: { pausedAt: null, status: 'ACTIVE' } },
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
      prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(true)
    expect(tx.prospectSendOutbox.updateMany).not.toHaveBeenCalled()
  })

  it('suppresses a claimed operation when the contact opts out before the provider call', async () => {
    const normalizedEmail = 'reviewer@torchiko.test'
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({
          deliveryEnabled: true,
          internalOnly: false,
          internalAllowlist: [],
        }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-1',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
          providerAccount: {
            provider: 'GMAIL',
            capabilities: ['SEND'],
            deliveryEnabled: true,
            pausedAt: null,
            connectionStatus: 'CONNECTED',
          },
          sendItem: {
            id: 'item-1',
            recipientEmailSnapshot: normalizedEmail,
            recipientIdentityHash: createHash('sha256').update(normalizedEmail).digest('hex'),
            member: {
              contact: {
                normalizedEmail,
                archivedAt: null,
                doNotContact: false,
                emailReadiness: 'VALID',
                permissionState: 'OPTED_OUT',
                suppressedAt: null,
                unsubscribedAt: new Date('2026-08-22T15:59:00.000Z'),
              },
            },
            batch: { campaign: { pausedAt: null, status: 'ACTIVE' } },
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }

    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUPPRESSED',
          lastErrorCode: 'CONTACT_SUPPRESSED',
        }),
      }),
    )
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SUPPRESSED' }),
      }),
    )
  })
})

describe('prospect send claim rate reservation', () => {
  it('cancels a newly claimed operation when the current internal allowlist excludes it', async () => {
    const operation = {
      id: 'outbox-1',
      operationId: '00000000-0000-0000-0000-000000000001',
      providerAccountId: 'mailbox-1',
      status: 'PENDING',
      availableAt: new Date('2026-08-22T15:00:00.000Z'),
      claimOwner: null,
      claimExpiresAt: null,
      providerAccount: {
        dailySendCap: 100,
        perDomainDailyCap: 10,
        minimumDelaySeconds: 0,
        jitterSeconds: 0,
        deliveryEnabled: true,
        pausedAt: null,
        connectionStatus: 'CONNECTED',
      },
      sendItem: {
        id: 'item-1',
        batchId: 'batch-1',
        recipientEmailSnapshot: 'removed@torchiko.test',
        recipientIdentityHash: 'unused-after-control-rejection',
        batch: {
          campaignId: 'campaign-1',
          campaign: { dailySendCap: 100, pausedAt: null, status: 'ACTIVE' },
        },
        member: { contact: null },
      },
    }
    const claimedOperation = { ...operation, status: 'CLAIMED', claimOwner: 'worker-1' }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: ['reviewer@torchiko.test'],
        }),
      },
      prospectSendOutbox: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(operation)
          .mockResolvedValueOnce(claimedOperation),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn(),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = {
      $transaction: vi.fn((work) => work(tx)),
      prospectSendBatch: { findUnique: vi.fn(), update: vi.fn() },
      prospectSendItem: { count: vi.fn() },
    }

    await expect(
      claimProspectSendOutboxAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBeNull()
    expect(tx.prospectSendOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', lastErrorCode: 'DELIVERY_DISABLED' }),
      }),
    )
  })

  it('serializes the send lane and defers an operation when a configured cap is exhausted', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          operationId: '00000000-0000-0000-0000-000000000001',
          providerAccountId: 'mailbox-1',
          status: 'PENDING',
          availableAt: new Date('2026-08-22T15:00:00.000Z'),
          claimOwner: null,
          claimExpiresAt: null,
          providerAccount: {
            dailySendCap: 0,
            perDomainDailyCap: 2,
            minimumDelaySeconds: 180,
            jitterSeconds: 0,
          },
          sendItem: {
            recipientEmailSnapshot: 'venue@example.com',
            batch: { campaignId: 'campaign-1', campaign: { dailySendCap: 10 } },
          },
        }),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany,
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      claimProspectSendOutboxAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBeNull()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(updateMany).toHaveBeenCalledOnce()
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETRYABLE',
          availableAt: new Date('2026-08-23T00:00:00.000Z'),
          lastErrorCode: 'DAILY_CAP',
        }),
      }),
    )
  })
})

describe('prospect frozen launch attachment readback', () => {
  const now = new Date('2026-08-22T16:00:00.000Z')

  it('returns the exact reviewed attachment from the leased outbox send', async () => {
    const recipient = 'prospect@example.test'
    const snapshot = { launchAttachments: [frozenAsset] }
    const contentHashSnapshot = prospectOperationalContentHash(
      recipient,
      'A visitor guide',
      'Scan the attached code.',
      '',
      snapshot,
    )
    const pending = {
      id: 'outbox-1',
      operationId: '00000000-0000-4000-8000-000000000001',
      providerAccountId: 'mailbox-1',
      status: 'PENDING',
      availableAt: new Date(now.valueOf() - 60_000),
      claimOwner: null,
      claimExpiresAt: null,
      attemptCount: 0,
      providerIdempotencyKey: 'outbox-key-1',
      providerAccount: {
        id: 'mailbox-1',
        provider: 'GMAIL',
        externalAccountId: 'me',
        credentialReferenceId: 'credential-1',
        mailboxAddress: 'sender@example.test',
        dailySendCap: 100,
        perDomainDailyCap: 100,
        minimumDelaySeconds: 0,
        jitterSeconds: 0,
        deliveryEnabled: true,
        pausedAt: null,
        connectionStatus: 'CONNECTED',
      },
      sendItem: {
        id: 'item-1',
        batchId: 'batch-1',
        recipientEmailSnapshot: recipient,
        recipientIdentityHash: createHash('sha256').update(recipient).digest('hex'),
        subjectSnapshot: 'A visitor guide',
        textBodySnapshot: 'Scan the attached code.',
        htmlBodySnapshot: null,
        contentHashSnapshot,
        headerSnapshot: {
          launchAttachments: [frozenAsset],
          launchAttachmentsSha256: launchAttachmentsSha256([frozenAsset]),
        },
        draft: { groundingSnapshot: snapshot },
        batch: {
          campaignId: 'campaign-1',
          campaign: { dailySendCap: 100, pausedAt: null, status: 'ACTIVE' },
        },
        member: {
          contact: {
            normalizedEmail: recipient,
            archivedAt: null,
            doNotContact: false,
            emailReadiness: 'VALID',
            permissionState: 'LEGITIMATE_INTEREST_RECORDED',
            suppressedAt: null,
            unsubscribedAt: null,
          },
        },
      },
    }
    const claimed = {
      ...pending,
      status: 'CLAIMED',
      claimOwner: 'worker-1',
      claimExpiresAt: new Date(now.valueOf() + 120_000),
      attemptCount: 1,
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(claimed),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectDeliveryControl: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ deliveryEnabled: true, internalOnly: false, internalAllowlist: [] }),
      },
      prospectSendItem: { update: vi.fn() },
      prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const client = {
      $transaction: vi.fn((work) => work(tx)),
      prospectSendBatch: { findUnique: vi.fn(), update: vi.fn() },
      prospectSendItem: { count: vi.fn() },
    }

    const frozen = await claimProspectSendOutboxAction(
      { outboxId: 'outbox-1', workerId: 'worker-1', now },
      client as never,
    )

    expect(frozen?.launchAttachments).toEqual([frozenAsset])
  })
})

describe('prospect reply stop boundary', () => {
  beforeEach(() => attachmentMocks.current.mockReset())
  const now = new Date('2026-08-22T16:00:00.000Z')
  const createdAt = new Date('2026-08-22T15:00:00.000Z')
  const recipient = 'prospect@example.test'
  const operation = (memberStatus = 'QUEUED', attemptCount = 1) => ({
    id: 'outbox-1',
    attemptCount,
    status: 'CLAIMED',
    claimOwner: 'worker-1',
    claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
    providerAccount: {
      provider: 'GMAIL',
      capabilities: ['SEND'],
      deliveryEnabled: true,
      pausedAt: null,
      connectionStatus: 'CONNECTED',
    },
    sendItem: {
      id: 'item-1',
      createdAt,
      recipientEmailSnapshot: recipient,
      recipientIdentityHash: createHash('sha256').update(recipient).digest('hex'),
      member: {
        id: 'member-1',
        organizationId: 'organization-1',
        contactId: 'contact-1' as string | null,
        status: memberStatus,
        contact: {
          normalizedEmail: recipient,
          archivedAt: null,
          doNotContact: false,
          emailReadiness: 'VALID',
          permissionState: 'UNKNOWN',
          suppressedAt: null,
          unsubscribedAt: null,
        },
      },
      batch: { campaign: { pausedAt: null, status: 'ACTIVE' } },
    },
  })

  function clientFor(current = operation(), reply: { id: string } | null = null) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({
          deliveryEnabled: true,
          internalOnly: false,
          internalAllowlist: [],
        }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
        updateMany,
      },
      prospectSendItem: { update: vi.fn() },
      prospectEmailMessage: { findFirst: vi.fn().mockResolvedValue(reply) },
    }
    return { tx, updateMany, client: { $transaction: vi.fn((work) => work(tx)) } }
  }

  it('cancels a direct REPLIED member before provider revalidation', async () => {
    const { client, tx } = clientFor(operation('REPLIED'))
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'CLAIMED' }) }),
    )
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastErrorCode: 'REPLY_RECEIVED_BEFORE_PROVIDER' }),
      }),
    )
    expect(tx.prospectEmailMessage.findFirst).not.toHaveBeenCalled()
  })

  it('queries exact organization/contact/from scope and createdAt boundary', async () => {
    const { client, tx } = clientFor()
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(true)
    expect(tx.prospectEmailMessage.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'organization-1',
        direction: 'INBOUND',
        createdAt: { gte: createdAt },
        OR: expect.arrayContaining([
          expect.objectContaining({ contactId: 'contact-1' }),
          expect.objectContaining({
            fromAddress: { equals: recipient, mode: 'insensitive' },
          }),
        ]),
      }),
      select: { id: true },
    })
  })

  it('revalidates frozen PDF bytes through the trusted persisted-attachment path', async () => {
    attachmentMocks.current.mockResolvedValueOnce([frozenPdfAsset])
    const attachmentHash = launchAttachmentsSha256([frozenPdfAsset])
    const contentHash = prospectOperationalContentHash(
      recipient,
      'Approved subject',
      'Approved body',
      '',
      { launchAttachments: [frozenPdfAsset] },
    )
    const claimed = operation()
    const current = {
      ...claimed,
      sendItem: {
        ...claimed.sendItem,
        batchId: 'batch-1',
        subjectSnapshot: 'Approved subject',
        textBodySnapshot: 'Approved body',
        htmlBodySnapshot: null,
        contentHashSnapshot: contentHash,
        headerSnapshot: {
          launchAttachments: [frozenPdfAsset],
          launchAttachmentsSha256: attachmentHash,
        },
        draft: {
          venueId: 'venue-1',
          groundingSnapshot: { launchAttachments: [frozenPdfAsset] },
        },
        member: {
          ...claimed.sendItem.member,
          venue: { id: 'venue-1' },
        },
      },
    }
    const { client } = clientFor(current)

    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(true)
    expect(attachmentMocks.current).toHaveBeenCalledWith(
      'venue-1',
      [frozenPdfAsset],
      expect.objectContaining({ allowFrozenVerifiedPrintAttachments: true }),
    )
  })

  it('cancels when the bounded canonical inbound lookup finds a reply', async () => {
    const { client, tx } = clientFor(undefined, { id: 'reply-1' })
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    )
  })

  it('does not mutate the item when the claimed lease was stolen before CAS cancellation', async () => {
    const { client, tx, updateMany } = clientFor(undefined, { id: 'reply-1' })
    updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
  })

  it.each([2, 3])('preserves uncertain prior delivery on attempt %i', async (attemptCount) => {
    const { client, tx } = clientFor(operation('REPLIED', attemptCount))
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'AMBIGUOUS',
          ambiguousSince: now,
          lastErrorCode: 'REPLY_RECEIVED_AFTER_PRIOR_ATTEMPT',
        }),
      }),
    )
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'AMBIGUOUS' }) }),
    )
  })

  it.each([1, 2])(
    'stops a replied campaign member at claim attempt %i with honest delivery state',
    async (attemptCount) => {
      const claimed = operation('REPLIED', attemptCount)
      const full = {
        ...claimed,
        operationId: '00000000-0000-4000-8000-000000000001',
        providerAccountId: 'mailbox-1',
        availableAt: createdAt,
        providerAccount: {
          ...claimed.providerAccount,
          dailySendCap: 100,
          perDomainDailyCap: 100,
          minimumDelaySeconds: 0,
          jitterSeconds: 0,
        },
        sendItem: {
          ...claimed.sendItem,
          batchId: 'batch-1',
          batch: {
            ...claimed.sendItem.batch,
            campaignId: 'campaign-1',
            campaign: { ...claimed.sendItem.batch.campaign, dailySendCap: 100 },
          },
        },
      }
      const { tx } = clientFor(full)
      tx.prospectSendOutbox.findUnique
        .mockResolvedValueOnce({
          ...full,
          status: 'RETRYABLE',
          claimOwner: null,
          claimExpiresAt: null,
          attemptCount: attemptCount - 1,
        })
        .mockResolvedValueOnce(full)
      const client = {
        $transaction: vi.fn((work) =>
          work({
            ...tx,
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
            prospectSendOutbox: {
              ...tx.prospectSendOutbox,
              count: vi.fn().mockResolvedValue(0),
              findFirst: vi.fn().mockResolvedValue(null),
            },
          }),
        ),
        prospectSendBatch: {
          findUnique: vi.fn().mockResolvedValue({ id: 'batch-1' }),
          update: vi.fn(),
        },
        prospectSendItem: {
          count: vi
            .fn()
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(attemptCount > 1 ? 1 : 0)
            .mockResolvedValueOnce(attemptCount > 1 ? 0 : 1),
        },
      }
      await expect(
        claimProspectSendOutboxAction(
          { outboxId: full.id, workerId: 'worker-1', now },
          client as never,
        ),
      ).resolves.toBeNull()
      const expectedStatus = attemptCount > 1 ? 'AMBIGUOUS' : 'CANCELLED'
      expect(tx.prospectSendOutbox.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: expectedStatus }) }),
      )
      expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: expectedStatus }) }),
      )
      expect(client.prospectSendBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: attemptCount > 1 ? 'ATTENTION_REQUIRED' : 'PARTIAL',
          }),
        }),
      )
    },
  )

  it.each(['delivery', 'contact', 'reply'] as const)(
    'does not overwrite a replacement lease on %s stop',
    async (stop) => {
      const current = operation()
      if (stop === 'contact') current.sendItem.member.contact.doNotContact = true
      const { client, tx, updateMany } = clientFor(
        current,
        stop === 'reply' ? { id: 'reply-1' } : null,
      )
      if (stop === 'delivery')
        tx.prospectDeliveryControl.findUnique.mockResolvedValue({ deliveryEnabled: false })
      updateMany.mockResolvedValue({ count: 0 })
      await expect(
        revalidateProspectSendOutboxClaimAction(
          { outboxId: current.id, workerId: 'worker-1', now },
          client as never,
        ),
      ).resolves.toBe(false)
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: current.id,
            status: 'CLAIMED',
            claimOwner: 'worker-1',
            claimExpiresAt: { equals: current.claimExpiresAt, gt: now },
          },
        }),
      )
      expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
    },
  )

  it('does not use a missing contact ID as shared reply identity', async () => {
    const current = operation()
    const { client, tx } = clientFor({
      ...current,
      sendItem: { ...current.sendItem, member: { ...current.sendItem.member, contactId: null } },
    })
    await revalidateProspectSendOutboxClaimAction(
      { outboxId: current.id, workerId: 'worker-1', now },
      client as never,
    )
    const where = tx.prospectEmailMessage.findFirst.mock.calls[0]?.[0].where
    expect(where.organizationId).toBe('organization-1')
    expect(where.OR).toHaveLength(2)
    expect(where.OR.some((clause: object) => 'contactId' in clause)).toBe(false)
  })

  it('fails closed if canonical reply lookup fails', async () => {
    const { client, tx } = clientFor()
    tx.prospectEmailMessage.findFirst.mockRejectedValue(new Error('database unavailable'))
    await expect(
      revalidateProspectSendOutboxClaimAction(
        { outboxId: 'outbox-1', workerId: 'worker-1', now },
        client as never,
      ),
    ).rejects.toThrow('database unavailable')
    expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
  })
})

describe('prospect send lease completion', () => {
  it('rejects a stale worker completion without changing the send item', async () => {
    const tx = {
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          sendItem: { id: 'item-1', batchId: 'batch-1' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      recordProspectSendFailureAction(
        {
          outboxId: 'outbox-1',
          workerId: 'stale-worker',
          code: 'TRANSIENT',
          retryable: true,
          acceptanceAmbiguous: false,
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'CLAIMED',
          claimOwner: 'stale-worker',
          claimExpiresAt: { gt: new Date('2026-08-22T16:00:00.000Z') },
        }),
      }),
    )
    expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
  })

  it('derives durable failure detail from the bounded code', async () => {
    const tx = {
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          sendItem: { id: 'item-1', batchId: 'batch-1' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = {
      $transaction: vi.fn((work) => work(tx)),
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        update: vi.fn(),
      },
      prospectSendItem: {
        count: vi.fn().mockResolvedValue(0),
      },
    }
    await recordProspectSendFailureAction(
      {
        outboxId: 'outbox-1',
        workerId: 'worker-1',
        code: 'TRANSIENT',
        retryable: true,
        acceptanceAmbiguous: false,
        now: new Date('2026-08-22T16:00:00.000Z'),
      },
      client as never,
    )
    const expected = {
      lastErrorCode: 'TRANSIENT',
      lastErrorMessage: 'Prospect delivery failed (TRANSIENT).',
    }
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expected) }),
    )
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expected) }),
    )
  })
})
