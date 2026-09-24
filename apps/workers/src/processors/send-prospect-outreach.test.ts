import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '@pathfinder/db'

import {
  _setProspectCorrespondenceProviderForTesting,
  sendOrRecoverProspectCorrespondence,
  processSendProspectOutreachJob,
  prospectSendOperationFingerprint,
  isProspectRecipientAllowed,
} from './send-prospect-outreach'

describe('prospect correspondence worker safety', () => {
  const original = process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED
  const originalMode = process.env.PROSPECT_OUTREACH_RECIPIENT_MODE
  const originalAllowlist = process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST

  afterEach(() => {
    vi.restoreAllMocks()
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = original
    process.env.PROSPECT_OUTREACH_RECIPIENT_MODE = originalMode
    process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST = originalAllowlist
    _setProspectCorrespondenceProviderForTesting(undefined)
  })

  it('defaults to an exact internal-recipient allowlist and requires an explicit production mode', () => {
    delete process.env.PROSPECT_OUTREACH_RECIPIENT_MODE
    process.env.PROSPECT_OUTREACH_INTERNAL_ALLOWLIST = 'Internal@One.test, second@one.test'
    expect(isProspectRecipientAllowed('internal@one.test')).toBe(true)
    expect(isProspectRecipientAllowed('prospect@external.test')).toBe(false)
    process.env.PROSPECT_OUTREACH_RECIPIENT_MODE = 'production'
    expect(isProspectRecipientAllowed('prospect@external.test')).toBe(true)
  })

  it('allows only a bounded recovery status read while delivery is disabled', async () => {
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'false'
    const statusRead = vi.spyOn(db.prospectSendOutbox, 'findUnique').mockResolvedValue(null)
    await expect(processSendProspectOutreachJob({ outboxId: 'outbox-1' })).rejects.toThrow(
      'disabled',
    )
    expect(statusRead).toHaveBeenCalledOnce()
  })

  it('uses durable outbox identity rather than a mutable draft or recipient', () => {
    expect(prospectSendOperationFingerprint('outbox-1')).toHaveLength(64)
    expect(prospectSendOperationFingerprint('outbox-1')).toBe(
      prospectSendOperationFingerprint('outbox-1'),
    )
    expect(prospectSendOperationFingerprint('outbox-1')).not.toBe(
      prospectSendOperationFingerprint('outbox-2'),
    )
  })

  it('recovers a provider-accepted retry by RFC Message-ID without a duplicate send', async () => {
    const acceptedAt = new Date('2026-08-22T16:00:00.000Z')
    const result = {
      operationId: 'operation-1',
      message: {
        provider: 'GMAIL',
        providerAccountId: 'mailbox-1',
        mailboxId: 'me',
        externalId: 'message-1',
      },
      thread: {
        provider: 'GMAIL',
        providerAccountId: 'mailbox-1',
        mailboxId: 'me',
        externalId: 'thread-1',
      },
      rfcMessageId: '<torchiko.operation-1@torchiko.com>',
      acceptedAt,
    }
    const provider = {
      sendOne: vi.fn(),
      lookupSendOperation: vi.fn().mockResolvedValue({ state: 'FOUND', result }),
    }
    const frozen = {
      operationId: 'operation-1',
      providerIdempotencyKey: 'outbox-key-1',
      mailbox: {
        provider: 'GMAIL',
        providerAccountId: 'mailbox-1',
        mailboxId: 'me',
        mailboxAddress: 'internal@example.test',
        credentialRef: 'credential-1',
      },
      recipient: { email: 'prospect@example.test' },
      from: { email: 'internal@example.test' },
      subject: 'Subject',
      textBody: 'Body',
      rfcMessageId: '<torchiko.operation-1@torchiko.com>',
      references: [],
      attachments: [
        {
          schema: 'torchiko.venue-launch-asset/1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          release: { kind: 'LEGACY', id: 'legacy:venue-1', revisionSha256: 'a'.repeat(64) },
          publicUrl: 'https://guide.example.com/venue/chat?source=qr',
          filename: 'venue-qr.svg',
          mimeType: 'image/svg+xml',
          sizeBytes: 4,
          sha256: 'b'.repeat(64),
          contentBase64: 'PHN2Zz4=',
        },
      ],
    } as const

    await expect(
      sendOrRecoverProspectCorrespondence(provider as never, frozen, 2),
    ).resolves.toEqual(result)
    expect(provider.lookupSendOperation).toHaveBeenCalledOnce()
    expect(provider.lookupSendOperation.mock.calls[0]?.[0].expected).toMatchObject({
      senderEmail: 'internal@example.test',
      recipientEmail: 'prospect@example.test',
      attachments: frozen.attachments,
    })
    expect(provider.sendOne).not.toHaveBeenCalled()
  })

  it('blocks a blind retry when provider lookup cannot prove non-acceptance', async () => {
    const provider = {
      sendOne: vi.fn(),
      lookupSendOperation: vi.fn().mockResolvedValue({ state: 'NOT_FOUND' }),
    }
    const frozen = {
      operationId: 'operation-1',
      providerIdempotencyKey: 'outbox-key-1',
      mailbox: {
        provider: 'GMAIL',
        providerAccountId: 'mailbox-1',
        mailboxId: 'me',
        mailboxAddress: 'internal@example.test',
        credentialRef: 'credential-1',
      },
      recipient: { email: 'prospect@example.test' },
      from: { email: 'internal@example.test' },
      subject: 'Subject',
      textBody: 'Body',
      rfcMessageId: '<torchiko.operation-1@torchiko.com>',
      references: [],
    } as const

    await expect(
      sendOrRecoverProspectCorrespondence(provider as never, frozen, 2),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SEND' })
    expect(provider.sendOne).not.toHaveBeenCalled()
  })
})
