import { describe, expect, it } from 'vitest'

import { createFakeCorrespondenceProvider } from './fake'

describe('fake correspondence provider', () => {
  it('provides deterministic send, retrieve, sync, and lookup behavior', async () => {
    const provider = createFakeCorrespondenceProvider()
    const mailbox = {
      provider: 'FAKE' as const,
      providerAccountId: 'fake-account',
      mailboxId: 'fake-mailbox',
      mailboxAddress: 'test@torchiko.invalid',
      credentialRef: 'fake-only',
    }
    const sent = await provider.sendOne({
      operationId: 'op-1',
      providerIdempotencyKey: 'op-1',
      mailbox,
      recipient: { email: 'recipient@example.invalid' },
      from: { email: mailbox.mailboxAddress },
      subject: 'Fixture',
      textBody: 'Fixture only',
      rfcMessageId: '<op-1@torchiko.invalid>',
      references: [],
    })
    expect(provider.state.sent).toHaveLength(1)
    await expect(provider.retrieveMessage(mailbox, sent.message)).resolves.toMatchObject({
      direction: 'OUTBOUND',
      subject: 'Fixture',
    })
    await expect(
      provider.lookupSendOperation({
        mailbox,
        operationId: 'op-1',
        rfcMessageId: '<op-1@torchiko.invalid>',
      }),
    ).resolves.toMatchObject({ state: 'FOUND' })
    await expect(
      provider.syncIncremental({ mailbox, cursor: '0', pageSize: 10 }),
    ).resolves.toMatchObject({ mode: 'INCREMENTAL', hasMore: false })
  })
})
