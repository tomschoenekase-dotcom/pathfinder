import { describe, expect, it } from 'vitest'
import { operationId, stableId, stagingGuard, validatePlan } from './prospect-outreach-cohort-plan'
const observation = {
  providerMessageId: 'provider-1',
  providerThreadId: 'thread-1',
  fromAddress: 'sender@example.com',
  toAddresses: ['team@example.org'],
  subject: 'Visitor guide',
  occurredAt: '2026-10-01T12:00:00.000Z',
  labels: ['SENT'],
  classification: 'cold',
}
const plan = () => ({
  schema: 'staging-outreach-cohort/v1',
  mailboxAddress: 'sender@example.com',
  sourceReceiptId: 'private-receipt',
  sourceReceiptSha256: 'a'.repeat(64),
  sourceHashes: { audit: 'b'.repeat(64) },
  cohort: [
    {
      key: 'sample',
      target: {
        kind: 'existing',
        id: 'staging-account',
        expectedCanonicalName: 'Example venue',
        verifiedIdentityReceipt: 'verified-staging-identity',
      },
      globalHistoryComplete: false,
      messages: [{ ...observation }],
      limitations: ['Historical mailbox coverage incomplete'],
    },
  ],
})
describe('staging cohort admission', () => {
  it('refuses every guard when staging identity is missing or wrong', () => {
    const env = {
      RAILWAY_ENVIRONMENT_ID: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
      DATABASE_RESOURCE_ID: '7bd81064-588f-48a5-b138-1fc86691a09b',
      RAILWAY_PROJECT_ID: '8621111a-4ac8-4d88-9566-4627c8a02059',
    }
    expect(() => stagingGuard(env)).not.toThrow()
    for (const key of Object.keys(env))
      expect(() => stagingGuard({ ...env, [key]: 'different' })).toThrow(
        'STAGING_IDENTITY_REQUIRED',
      )
  })
  it('uses deterministic local identities and UUID operations', () => {
    expect(stableId('org', 'example.org')).toBe(stableId('org', 'example.org'))
    expect(stableId('contact', 'example.org')).not.toBe(stableId('org', 'example.org'))
    expect(operationId('source')).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    )
  })
  it('forbids draft-labelled observations even if also SENT', () => {
    const p = plan()
    p.cohort[0]!.messages[0]!.labels = ['SENT', 'DRAFT']
    expect(() => validatePlan(p)).toThrow('DRAFT_OBSERVATION_FORBIDDEN')
  })
  it('rejects forged completeness and global message duplication', () => {
    expect(() =>
      validatePlan({ ...plan(), cohort: [{ ...plan().cohort[0], globalHistoryComplete: true }] }),
    ).toThrow()
    const p = plan()
    p.cohort[0]!.messages.push({ ...observation })
    expect(() => validatePlan(p)).toThrow('DUPLICATE_PROVIDER_MESSAGE')
  })
  it('requires new observation identity to bind a sent recipient and domain', () => {
    const p = plan()
    const target = {
      kind: 'createObservation',
      canonicalName: 'Example venue',
      normalizedDomain: 'example.org',
      verifiedRecipient: 'team@example.org',
      sourceProviderMessageId: 'provider-1',
      verifiedIdentityReceipt: 'private-identity',
    }
    expect(() => validatePlan({ ...p, cohort: [{ ...p.cohort[0], target }] })).not.toThrow()
    expect(() =>
      validatePlan({
        ...p,
        cohort: [{ ...p.cohort[0], target: { ...target, normalizedDomain: 'other.org' } }],
      }),
    ).toThrow('NEW_OBSERVATION_IDENTITY_UNBOUND')
  })
  it('requires exact original recipient and same-thread actual DSN for a bounce', () => {
    const p = plan(),
      original = p.cohort[0]!
    const dsn = {
      ...observation,
      providerMessageId: 'dsn',
      fromAddress: 'mailer-daemon@example.net',
      toAddresses: ['sender@example.com'],
      labels: ['INBOX'],
      classification: 'bounce',
    }
    const bounce = {
      recipientAddress: 'team@example.org',
      originalProviderMessageId: 'provider-1',
      dsnProviderMessageId: 'dsn',
    }
    expect(() =>
      validatePlan({ ...p, cohort: [{ ...original, messages: [observation, dsn], bounce }] }),
    ).not.toThrow()
    expect(() =>
      validatePlan({
        ...p,
        cohort: [
          {
            ...original,
            messages: [observation, dsn],
            bounce: { ...bounce, recipientAddress: 'other@example.org' },
          },
        ],
      }),
    ).toThrow('BOUNCE_RECIPIENT_EVIDENCE_UNBOUND')
  })
})
