import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createFakeCorrespondenceProvider } from '@pathfinder/api/correspondence'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { sendOrRecoverProspectCorrespondence } from './send-prospect-outreach'

const publicUrl = 'https://example.com/chat?source=qr'
const bytes = Buffer.from(renderVenueQrSvg(publicUrl), 'utf8')
const attachment: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant',
  venueId: 'venue',
  release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
  publicUrl,
  filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  contentBase64: bytes.toString('base64'),
}

describe('venue launch outbox recovery through fake provider', () => {
  it('recovers the exact accepted QR after a lost response without sending again', async () => {
    const provider = createFakeCorrespondenceProvider()
    const mailbox = {
      provider: 'FAKE' as const,
      providerAccountId: 'account',
      mailboxId: 'mailbox',
      mailboxAddress: 'sender@torchiko.invalid',
      credentialRef: 'fake',
    }
    const frozen = {
      operationId: 'operation',
      providerIdempotencyKey: 'outbox-1',
      mailbox,
      recipient: { email: 'recipient@example.invalid' },
      from: { email: mailbox.mailboxAddress },
      subject: 'Visit',
      textBody: 'See the venue QR.',
      rfcMessageId: '<operation@torchiko.invalid>',
      references: [],
      attachments: [attachment],
    }
    // The first provider acceptance is durable, but its response is lost to the worker.
    const accepted = await provider.sendOne(frozen)
    expect(provider.state.sent).toHaveLength(1)
    expect(provider.state.sent[0]?.attachments).toEqual([attachment])
    expect((await provider.retrieveMessage(mailbox, accepted.message)).attachments).toMatchObject([
      {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        downloadPolicy: 'METADATA_ONLY',
      },
    ])
    const recovered = await sendOrRecoverProspectCorrespondence(provider, frozen, 2)
    expect(recovered).toEqual(accepted)
    expect(provider.state.sent).toHaveLength(1)
    await expect(
      sendOrRecoverProspectCorrespondence(
        provider,
        {
          ...frozen,
          attachments: [{ ...attachment, publicUrl: 'https://changed.example/chat?source=qr' }],
        },
        2,
      ),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SEND' })
    expect(provider.state.sent).toHaveLength(1)
  })
})
