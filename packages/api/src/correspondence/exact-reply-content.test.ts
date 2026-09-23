import { describe, expect, it, vi } from 'vitest'

import { normalizeUntrustedCorrespondenceBody } from './content-safety'
import { createFakeCorrespondenceProvider } from './fake'
import { readExactSourceOnlyReplyContent, type ExactSourceOnlyReplySelection } from './exact-reply-content'

const mailbox = {
  provider: 'FAKE' as const,
  providerAccountId: 'account-1',
  mailboxId: 'box-1',
  mailboxAddress: 'team@example.test',
  credentialRef: 'fixture-only',
}

const selected: ExactSourceOnlyReplySelection = {
  canonicalMessageId: 'message-1',
  canonicalThreadId: 'thread-1',
  organizationId: 'organization-1',
  provider: 'FAKE',
  providerAccountId: mailbox.providerAccountId,
  mailboxId: mailbox.mailboxId,
  providerMessageId: 'provider-message-1',
  providerThreadId: 'provider-thread-1',
  internetMessageId: '<reply@example.test>',
  fromAddress: 'person@example.test',
  subject: 'Re: Exhibit',
  occurredAt: new Date('2026-09-22T00:00:00.000Z'),
  sourceReference: 'synthetic:crm-sales:fake-provider:provider-message-1',
  direction: 'INBOUND',
  bodyRetentionState: 'NOT_STORED',
}

function fixture() {
  const provider = createFakeCorrespondenceProvider()
  provider.state.messages.set(selected.providerMessageId, {
    message: { ...mailbox, externalId: selected.providerMessageId },
    thread: { ...mailbox, externalId: selected.providerThreadId },
    rfcMessageId: selected.internetMessageId,
    inReplyTo: null,
    references: [],
    from: [{ email: selected.fromAddress }],
    to: [{ email: mailbox.mailboxAddress }],
    cc: [],
    bcc: [],
    subject: selected.subject,
    internalDate: selected.occurredAt,
    direction: 'INBOUND',
    body: normalizeUntrustedCorrespondenceBody({
      text: 'Yes, one room works.\n\nOn Monday Tom wrote:\n> Old pricing claim.',
    }),
    attachments: [],
  })
  return provider
}

describe('explicit exact SOURCE_ONLY reply read', () => {
  it('returns transient untrusted plaintext and a conservative projection', async () => {
    const provider = fixture()
    const result = await readExactSourceOnlyReplyContent({ provider, mailbox, selected })
    expect(result).toMatchObject({
      replyText: 'Yes, one room works.',
      omittedQuotedText: true,
      retention: 'TRANSIENT_SOURCE_READ',
      trust: 'UNTRUSTED_EXTERNAL_CONTENT',
      agentPolicy: 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION',
    })
    expect(result.rawText).toContain('Old pricing claim')
    expect(result.rawBodySha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('refuses a mismatched canonical source before provider retrieval', async () => {
    const provider = fixture()
    const retrieve = vi.spyOn(provider, 'retrieveMessage')
    await expect(readExactSourceOnlyReplyContent({
      provider, mailbox, selected: { ...selected, sourceReference: 'other' },
    })).rejects.toThrow('incomplete or mismatched')
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('refuses provider thread drift and incomplete body after retrieval', async () => {
    const provider = fixture()
    const original = provider.state.messages.get(selected.providerMessageId)!
    provider.state.messages.set(selected.providerMessageId, {
      ...original,
      thread: { ...original.thread, externalId: 'other-thread' },
    })
    await expect(readExactSourceOnlyReplyContent({ provider, mailbox, selected }))
      .rejects.toThrow('no longer matches')

    provider.state.messages.set(selected.providerMessageId, {
      ...original,
      body: normalizeUntrustedCorrespondenceBody({ text: '' }),
    })
    await expect(readExactSourceOnlyReplyContent({ provider, mailbox, selected }))
      .rejects.toThrow('missing or truncated')
  })
})
