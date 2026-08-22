import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('stays dark before any database claim or provider resolution', async () => {
    process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED = 'false'
    await expect(processSendProspectOutreachJob({ outboxId: 'outbox-1' })).rejects.toThrow(
      'disabled',
    )
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
      message: { provider: 'GMAIL', externalId: 'message-1' },
      thread: { provider: 'GMAIL', externalId: 'thread-1' },
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
    } as const

    await expect(
      sendOrRecoverProspectCorrespondence(provider as never, frozen, 2),
    ).resolves.toEqual(result)
    expect(provider.lookupSendOperation).toHaveBeenCalledOnce()
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
