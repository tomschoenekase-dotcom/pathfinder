import { describe, expect, it, vi } from 'vitest'

import { parseGmailPushEnvelope, verifyGooglePubSubPush } from './google-pubsub'

describe('Google Pub/Sub push boundary', () => {
  it('requires exact audience, service-account identity, and verified email', async () => {
    const verify = vi.fn().mockResolvedValue({
      sub: 'service-subject',
      email: 'push@project.iam.gserviceaccount.com',
      email_verified: true,
    })
    await expect(
      verifyGooglePubSubPush({
        authorization: 'Bearer signed.jwt.value',
        expectedAudience: 'https://staging.example.test/api/integrations/gmail/pubsub',
        expectedServiceAccount: 'push@project.iam.gserviceaccount.com',
        verify,
      }),
    ).resolves.toEqual({
      subject: 'service-subject',
      email: 'push@project.iam.gserviceaccount.com',
    })
    expect(verify).toHaveBeenCalledWith(
      'signed.jwt.value',
      'https://staging.example.test/api/integrations/gmail/pubsub',
    )
  })

  it('rejects an authenticated but unexpected service account', async () => {
    await expect(
      verifyGooglePubSubPush({
        authorization: 'Bearer signed.jwt.value',
        expectedAudience: 'https://staging.example.test/push',
        expectedServiceAccount: 'expected@example.test',
        verify: vi.fn().mockResolvedValue({
          sub: 'subject',
          email: 'attacker@example.test',
          email_verified: true,
        }),
      }),
    ).rejects.toThrow('PUBSUB_IDENTITY_REJECTED')
  })

  it('parses only bounded Gmail history hints', () => {
    expect(
      parseGmailPushEnvelope({
        message: {
          messageId: 'notification-1',
          data: Buffer.from(
            JSON.stringify({ emailAddress: 'Outreach@Torchiko.com', historyId: '12345' }),
          ).toString('base64'),
        },
        subscription: 'projects/project/subscriptions/gmail',
      }),
    ).toEqual({
      messageId: 'notification-1',
      emailAddress: 'outreach@torchiko.com',
      historyId: '12345',
      subscription: 'projects/project/subscriptions/gmail',
    })
  })
})
