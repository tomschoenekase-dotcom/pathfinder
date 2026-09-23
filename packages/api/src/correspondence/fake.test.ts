import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

import { createFakeCorrespondenceProvider } from './fake'

const attachmentBytes = Buffer.from('<svg/>')
const attachment: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant',
  venueId: 'venue',
  release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://example.com/chat?source=qr',
  filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: attachmentBytes.length,
  sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
  contentBase64: attachmentBytes.toString('base64'),
}

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
    const frozen = {
      operationId: 'op-1',
      providerIdempotencyKey: 'op-1',
      mailbox,
      recipient: { email: 'recipient@example.invalid' },
      from: { email: mailbox.mailboxAddress },
      subject: 'Fixture',
      textBody: 'Fixture only',
      rfcMessageId: '<op-1@torchiko.invalid>',
      references: [],
      attachments: [attachment],
    }
    const sent = await provider.sendOne(frozen)
    await expect(provider.sendOne(frozen)).resolves.toMatchObject({ operationId: 'op-1' })
    expect(provider.state.sent).toHaveLength(1)
    await expect(provider.retrieveMessage(mailbox, sent.message)).resolves.toMatchObject({
      direction: 'OUTBOUND',
      subject: 'Fixture',
      attachments: [
        { filename: 'venue-qr.svg', mimeType: 'image/svg+xml', sizeBytes: attachmentBytes.length },
      ],
    })
    await expect(
      provider.lookupSendOperation({
        mailbox,
        operationId: 'op-1',
        rfcMessageId: '<op-1@torchiko.invalid>',
        expected: {
          senderEmail: mailbox.mailboxAddress,
          recipientEmail: 'recipient@example.invalid',
          subject: 'Fixture',
          textBody: 'Fixture only',
          attachments: [attachment],
        },
      }),
    ).resolves.toMatchObject({ state: 'FOUND' })
    await expect(
      provider.lookupSendOperation({
        mailbox,
        operationId: 'op-1',
        rfcMessageId: '<op-1@torchiko.invalid>',
        expected: {
          senderEmail: mailbox.mailboxAddress,
          recipientEmail: 'recipient@example.invalid',
          subject: 'Fixture',
          textBody: 'Changed text',
          attachments: [attachment],
        },
      }),
    ).resolves.toMatchObject({ state: 'NOT_FOUND' })
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
