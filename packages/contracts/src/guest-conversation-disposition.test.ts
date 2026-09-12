import { describe, expect, it } from 'vitest'

import {
  GUEST_CONVERSATION_DEFAULT_RETENTION_DAYS,
  GuestConversationDispositionRequest,
  GuestConversationDispositionAuthoritySnapshot,
  GuestConversationDispositionResult,
} from './guest-conversation-disposition'

const digest = 'a'.repeat(64)
const request = {
  version: 'guest-conversation-disposition-v1',
  operationId: '00000000-0000-4000-8000-000000000001',
  tenantId: 'synthetic-tenant',
  venueId: 'synthetic-venue',
  sessionId: 'synthetic-session',
  expectedPolicyVersion: 'synthetic-v1',
  expectedPolicySha256: digest,
  basis: { kind: 'RETENTION_EXPIRY' },
}
const identity = {
  version: 'guest-conversation-disposition-result-v1',
  operationId: request.operationId,
  tenantId: request.tenantId,
  venueId: request.venueId,
  sessionId: request.sessionId,
  observedUtc: '2026-09-12T00:00:00Z',
}
const committed = {
  ...identity,
  databaseState: 'COMMITTED',
  requestSha256: digest,
  resolvedPolicyVersion: 'synthetic-v1',
  resolvedPolicySha256: digest,
  effectiveCutoffUtc: '2025-09-12T00:00:00Z',
  databaseReceiptSha256: digest,
  externalIntentSha256: digest,
  affected: {
    sessions: 1,
    messages: 2,
    turns: 1,
    engagementResponses: 0,
    feedback: 0,
    analyticsEvents: 1,
  },
}
const pending = {
  ...committed,
  status: 'DB_COMMITTED_EXTERNAL_COMPLETION_PENDING',
  externalJournalState: 'INTENT_DURABLE',
  nextAction: 'RECONCILE_SAME_OPERATION',
}

describe('guest conversation disposition request boundary', () => {
  it('pins a server-resolved policy rather than accepting caller approval or cutoff', () => {
    expect(GuestConversationDispositionRequest.parse(request)).toEqual(request)
    expect(GUEST_CONVERSATION_DEFAULT_RETENTION_DAYS).toBe(365)
    for (const patch of [
      { approvedBy: 'claimed-owner' },
      { approvedAt: '2026-09-12T00:00:00Z' },
      { action: 'DELETE' },
      { retentionDays: 1 },
      { cutoffUtc: '2099-01-01T00:00:00Z' },
      { policy: { approvedBy: 'claimed-owner', action: 'DELETE' } },
    ]) {
      expect(GuestConversationDispositionRequest.safeParse({ ...request, ...patch }).success).toBe(
        false,
      )
    }
  })

  it('requires exact support request/version without making participation deletion authority', () => {
    const support = {
      ...request,
      basis: {
        kind: 'SUPPORT_REQUEST',
        supportRequestId: 'synthetic-support',
        expectedSupportRequestVersion: 3,
      },
    }
    expect(GuestConversationDispositionRequest.parse(support)).toEqual(support)
    for (const basis of [
      { kind: 'SUPPORT_REQUEST' },
      {
        kind: 'SUPPORT_REQUEST',
        supportRequestId: 'synthetic-support',
        expectedSupportRequestVersion: 0,
      },
      { ...support.basis, approved: true },
    ]) {
      expect(GuestConversationDispositionRequest.safeParse({ ...request, basis }).success).toBe(
        false,
      )
    }
  })

  it.each(['tenantId', 'venueId', 'sessionId'])('rejects missing or content-like %s', (key) => {
    for (const value of ['', 'message body', 'person@example.com', 'x'.repeat(192)]) {
      expect(
        GuestConversationDispositionRequest.safeParse({ ...request, [key]: value }).success,
      ).toBe(false)
    }
  })

  it('rejects malformed policy pins and operation identity', () => {
    for (const patch of [
      { expectedPolicyVersion: 'arbitrary prose or approval' },
      { expectedPolicySha256: 'not-a-hash' },
      { expectedPolicySha256: 'A'.repeat(64) },
      { operationId: 'not-a-uuid' },
    ]) {
      expect(GuestConversationDispositionRequest.safeParse({ ...request, ...patch }).success).toBe(
        false,
      )
    }
  })

  it('does not accept caller claims that dependencies or fences are resolved', () => {
    for (const key of ['holdsClear', 'providerDeleted', 'restoreSafe', 'allowImmutableMutation']) {
      expect(
        GuestConversationDispositionRequest.safeParse({ ...request, [key]: true }).success,
      ).toBe(false)
    }
    expect(
      GuestConversationDispositionRequest.safeParse({ ...request, anonymousToken: 'raw-token' })
        .success,
    ).toBe(false)
  })
})

describe('content-free disposition outcome boundary', () => {
  it('distinguishes a known database commit from durable external completion', () => {
    expect(GuestConversationDispositionResult.parse(pending)).toEqual(pending)
    for (const patch of [
      { databaseState: 'UNCHANGED' },
      { externalJournalState: 'COMPLETION_DURABLE' },
      { externalCompletionSha256: digest },
      { nextAction: 'RETRY_NEW_OPERATION' },
    ]) {
      expect(GuestConversationDispositionResult.safeParse({ ...pending, ...patch }).success).toBe(
        false,
      )
    }
  })

  it.each(['APPLIED', 'REPLAY'])('requires durable completion evidence for %s', (status) => {
    const result = {
      ...committed,
      status,
      externalJournalState: 'COMPLETION_DURABLE',
      externalCompletionSha256: digest,
    }
    expect(GuestConversationDispositionResult.parse(result)).toEqual(result)
    expect(
      GuestConversationDispositionResult.safeParse({
        ...result,
        externalCompletionSha256: undefined,
      }).success,
    ).toBe(false)
    expect(
      GuestConversationDispositionResult.safeParse({
        ...result,
        externalJournalState: 'INTENT_DURABLE',
      }).success,
    ).toBe(false)
  })

  it('reports uncertain commit as reconciliation rather than claiming refusal or application', () => {
    const result = {
      ...identity,
      status: 'RECONCILIATION_REQUIRED',
      databaseState: 'UNKNOWN',
      externalJournalState: 'INTENT_DURABLE',
      reason: 'DATABASE_COMMIT_UNCONFIRMED',
      nextAction: 'RECONCILE_SAME_OPERATION',
    }
    expect(GuestConversationDispositionResult.parse(result)).toEqual(result)
    expect(
      GuestConversationDispositionResult.safeParse({ ...result, databaseState: 'COMMITTED' })
        .success,
    ).toBe(false)
    expect(
      GuestConversationDispositionResult.safeParse({ ...result, affected: committed.affected })
        .success,
    ).toBe(false)
  })

  it('permits a named refusal only before any local fence or external intent', () => {
    const result = {
      ...identity,
      status: 'REFUSED',
      databaseState: 'UNCHANGED',
      externalJournalState: 'NOT_STARTED',
      refusals: ['LEGAL_HOLD', 'FEEDBACK_DISPOSITION_UNRESOLVED'],
    }
    expect(GuestConversationDispositionResult.parse(result)).toEqual(result)
    for (const patch of [
      { refusals: [] },
      { refusals: ['raw error body'] },
      { databaseState: 'FENCED' },
      { externalJournalState: 'INTENT_DURABLE' },
    ]) {
      expect(GuestConversationDispositionResult.safeParse({ ...result, ...patch }).success).toBe(
        false,
      )
    }
  })

  it('rejects raw content, locators and out-of-scope or invalid counts in receipts', () => {
    for (const key of [
      'message',
      'anonymousToken',
      'coordinates',
      'supportBody',
      'providerError',
      'objectKey',
    ]) {
      expect(
        GuestConversationDispositionResult.safeParse({ ...pending, [key]: 'sensitive' }).success,
      ).toBe(false)
    }
    for (const patch of [
      { sessions: 2 },
      { messages: -1 },
      { feedback: 1.5 },
      { transcript: 'sensitive' },
    ]) {
      expect(
        GuestConversationDispositionResult.safeParse({
          ...pending,
          affected: { ...pending.affected, ...patch },
        }).success,
      ).toBe(false)
    }
  })
})

describe('immutable maintenance authority snapshot', () => {
  const authority = {
    version: 'guest-disposition-authority-v1',
    actorId: 'synthetic-operator',
    actorRole: 'PLATFORM_ADMIN',
    policyVersion: 'fixture-v1',
    policySha256: digest,
    retentionDays: 365,
    holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256: digest },
    basis: {
      kind: 'SUPPORT_REQUEST',
      supportRequestId: 'synthetic-request',
      supportRequestVersion: 1,
      reviewedRequesterUserId: 'synthetic-recipient',
    },
  }
  it('retains the selected requester needed for the native current ACL check', () => {
    expect(GuestConversationDispositionAuthoritySnapshot.parse(authority).basis).toEqual(
      authority.basis,
    )
    expect(
      GuestConversationDispositionAuthoritySnapshot.safeParse({
        ...authority,
        basis: {
          kind: 'SUPPORT_REQUEST',
          supportRequestId: 'synthetic-request',
          supportRequestVersion: 1,
        },
      }).success,
    ).toBe(false)
  })
  it('rejects unresolved holds, caller prose and unversioned retention changes', () => {
    for (const patch of [
      { holdAssessment: { status: 'UNRESOLVED', referenceSha256: digest } },
      { approvedBy: 'caller prose' },
      { retentionDays: 30 },
    ]) {
      expect(
        GuestConversationDispositionAuthoritySnapshot.safeParse({ ...authority, ...patch }).success,
      ).toBe(false)
    }
  })
})
