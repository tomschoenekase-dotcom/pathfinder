import { describe, expect, it, vi } from 'vitest'
import { createGmailApiClient } from './gmail-http-client'
import { projectReplyText } from './reply-text'
import { chooseThreadMatch } from './inbound-sync'
import { createFakeCorrespondenceProvider } from './fake'
import type { FrozenCorrespondence } from './types'

describe('first-send provider/result and inbound boundaries', () => {
  it.each([
    {},
    { id: 'message-only' },
    { threadId: 'thread-only' },
    { id: '', threadId: 'thread' },
  ])('treats incomplete successful send response as ambiguous acceptance', async (response) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)))
    const api = createGmailApiClient({ fetch })
    await expect(
      api.sendMessage({
        accessToken: 'SYNTHETIC-UNIT-NO-REAL-TOKEN',
        mailboxAddress: 'fake@example.invalid',
        rawBase64Url: 'a',
      }),
    ).rejects.toMatchObject({ acceptance: 'MAY_HAVE_ACCEPTED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('retains a normal answer, not the old chain, in a conservative display projection', () => {
    const source =
      'Yes, could we start with one room?\n\nOn Monday Tom wrote:\n> An old proposal with facts not supplied for the reply.'
    expect(projectReplyText(source)).toMatchObject({
      text: 'Yes, could we start with one room?',
      omittedQuotedText: true,
    })
    expect(source).toContain('An old proposal')
  })
  it('retains plain unquoted incoming text verbatim apart from surrounding whitespace', () => {
    expect(projectReplyText('Could we start with one room?').text).toBe(
      'Could we start with one room?',
    )
  })
  it('keeps meaningful quoted or header-like text when no old-message block is confirmed', () => {
    const source =
      'On Friday we wrote: please bring the exhibit details.\n> Is the first room accessible?\nYes, it is.'
    expect(projectReplyText(source)).toMatchObject({
      text: source,
      omittedQuotedText: false,
    })
    expect(
      projectReplyText('From: Meg\nSubject: Accessibility\nPlease include this in the reply.'),
    ).toMatchObject({ omittedQuotedText: false })
  })
  it('quarantines conflicting exact provider and RFC ownership instead of choosing by precedence', () => {
    const candidate = {
      prospectOrganizationId: 'o',
      contactId: 'c',
      campaignMemberId: null,
      pendingFollowupIds: [],
    }
    expect(
      chooseThreadMatch([
        { ...candidate, canonicalThreadId: 'a', evidence: ['PROVIDER_THREAD'] },
        { ...candidate, canonicalThreadId: 'b', evidence: ['RFC_REFERENCE'] },
      ]),
    ).toMatchObject({ state: 'AMBIGUOUS' })
  })
  it('rehearses actual reply provider threading and duplicate operation recovery in the existing fake provider', async () => {
    const provider = createFakeCorrespondenceProvider()
    const mailbox = {
      provider: 'FAKE' as const,
      providerAccountId: 'account',
      mailboxId: 'box',
      mailboxAddress: 'sender@example.invalid',
      credentialRef: 'none',
    }
    const frozen: FrozenCorrespondence = {
      mailbox,
      operationId: 'test-operation',
      providerIdempotencyKey: 'key',
      recipient: { email: 'fixture@example.invalid' },
      from: { email: mailbox.mailboxAddress },
      subject: 'Re: a small guide',
      textBody: 'We could discuss one room.',
      rfcMessageId: '<reply@example.invalid>',
      providerThreadId: 'existing-provider-thread',
      inReplyTo: '<incoming@example.invalid>',
      references: ['<incoming@example.invalid>'],
    }
    const accepted = await provider.sendOne(frozen)
    expect(accepted.thread.externalId).toBe('existing-provider-thread')
    expect((await provider.retrieveMessage(mailbox, accepted.message)).inReplyTo).toBe(
      '<incoming@example.invalid>',
    )
    expect(
      await provider.lookupSendOperation({
        mailbox,
        operationId: frozen.operationId,
        rfcMessageId: frozen.rfcMessageId,
      }),
    ).toMatchObject({ state: 'FOUND' })
    expect(
      await provider.lookupSendOperation({
        mailbox: { ...mailbox, providerAccountId: 'other' },
        operationId: frozen.operationId,
        rfcMessageId: frozen.rfcMessageId,
      }),
    ).toMatchObject({ state: 'NOT_FOUND' })
    // A provider interface is not an idempotency guarantee. Recovery is a lookup,
    // not a second sendOne call; the actual worker duplicate path is tested separately.
    expect(provider.state.sent).toHaveLength(1)
  })
})
