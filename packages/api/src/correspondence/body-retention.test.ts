import { describe, expect, it } from 'vitest'

import { projectGmailBodyForPersistence } from './body-retention'
import type { NormalizedProviderMessage } from './types'

const message = {
  message: {
    provider: 'GMAIL',
    providerAccountId: 'account_1',
    mailboxId: 'owner@torchiko.com',
    externalId: 'message/one',
  },
  body: {
    text: '  Customer   requested a follow-up.  ',
    html: '<p>Customer requested a follow-up.</p>',
    truncated: false,
    trust: 'UNTRUSTED_EXTERNAL_CONTENT',
    renderingPolicy: 'TEXT_FIRST_HTML_REQUIRES_SANITIZATION',
    agentPolicy: 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION',
  },
} as NormalizedProviderMessage

describe('Gmail durable body projection', () => {
  it('defaults to source-only while preserving a bounded observation and retrieval link', () => {
    expect(
      projectGmailBodyForPersistence({
        message,
        ingestedAt: new Date('2026-08-22T00:00:00Z'),
      }),
    ).toEqual({
      textBody: null,
      htmlBody: null,
      bodyPreview: 'Customer requested a follow-up.',
      bodyRetentionState: 'NOT_STORED',
      bodyExpiresAt: null,
      sourceReference: 'https://mail.google.com/mail/u/owner%40torchiko.com/#all/message%2Fone',
    })
  })

  it('allows explicitly bounded temporary processing and rejects indefinite durations', () => {
    expect(
      projectGmailBodyForPersistence({
        message,
        ingestedAt: new Date('2026-08-22T00:00:00Z'),
        policy: { mode: 'TEMPORARY', retentionDays: 7 },
      }),
    ).toMatchObject({
      textBody: message.body.text,
      htmlBody: message.body.html,
      bodyRetentionState: 'TEMPORARY',
      bodyExpiresAt: new Date('2026-08-29T00:00:00Z'),
    })
    expect(() =>
      projectGmailBodyForPersistence({
        message,
        ingestedAt: new Date(),
        policy: { mode: 'TEMPORARY', retentionDays: 31 },
      }),
    ).toThrow(/between 1 and 30 days/)
  })
})
