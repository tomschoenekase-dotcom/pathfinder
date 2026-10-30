import { describe, expect, it, vi } from 'vitest'
vi.mock('../client', () => ({ db: {} }))
import {
  OUTREACH_EVIDENCE_SCHEMA,
  loadProspectOutreachHistory,
  projectProspectOutreachHistory,
  prospectOutreachHistoryFingerprint,
  prospectOutreachMessageFingerprint,
  type OutreachMessage,
  type OutreachActivity,
  type ProspectOutreachHistoryReader,
} from './prospect-outreach-history'

const now = new Date('2026-10-30T12:00:00.000Z')
function message(
  id: string,
  date: string,
  direction = 'OUTBOUND',
  status = 'SENT',
): OutreachMessage {
  return {
    id,
    organizationId: 'org',
    direction,
    status,
    providerAccountId: 'mailbox',
    providerMessageId: `provider-${id}`,
    occurredAt: new Date(date),
    fromAddress: direction === 'OUTBOUND' ? 'sender@example.com' : 'venue@example.org',
    toAddresses: [direction === 'OUTBOUND' ? 'venue@example.org' : 'sender@example.com'],
    subject: 'Visitor guide',
  }
}
function review(m: OutreachMessage, classification: string): OutreachActivity {
  return {
    actorId: 'reviewer',
    occurredAt: now,
    evidence: {
      schema: OUTREACH_EVIDENCE_SCHEMA,
      kind: 'message',
      reviewerId: 'reviewer',
      reason: 'Reviewed actual provider message',
      classification,
      binding: {
        messageId: m.id,
        providerAccountId: m.providerAccountId,
        providerMessageId: m.providerMessageId,
        fingerprint: prospectOutreachMessageFingerprint(m),
      },
    },
  }
}
function complete(messages: OutreachMessage[], organizationIds = ['org']): OutreachActivity {
  return {
    actorId: 'reviewer',
    occurredAt: now,
    evidence: {
      schema: OUTREACH_EVIDENCE_SCHEMA,
      kind: 'complete',
      reviewerId: 'reviewer',
      reason: 'Full bounded mailbox search',
      organizationIds,
      contactIds: ['contact'],
      mailboxIds: ['mailbox'],
      historyFingerprint: prospectOutreachHistoryFingerprint(messages, organizationIds),
      coverage: [
        {
          providerAccountId: 'mailbox',
          mailboxAddress: 'sender@example.com',
          searchedAt: now.toISOString(),
          throughAt: now.toISOString(),
          query: 'in:anywhere {to:venue@example.org from:venue@example.org}',
          sourceReceiptId: 'private-receipt',
          resultFingerprint: 'a'.repeat(64),
          complete: true,
        },
      ],
    },
  }
}
function project(
  messages: OutreachMessage[],
  activities: OutreachActivity[],
  options: Partial<Parameters<typeof projectProspectOutreachHistory>[0]> = {},
) {
  return projectProspectOutreachHistory({
    canonicalOrganizationId: 'org',
    organizationIds: ['org'],
    contactIds: ['contact'],
    expectedMailboxIds: ['mailbox'],
    messages,
    activities,
    stages: ['CONTACTED'],
    contactHealth: 'healthy',
    customer: false,
    hasUnsentDraft: false,
    now,
    ...options,
  })
}

describe('independent outreach projection review', () => {
  it('does not infer complete history from classified messages or imported stage', () => {
    const m = message('first', '2026-09-01T12:00:00.000Z')
    expect(project([m], [review(m, 'cold')])).toMatchObject({
      coldEmailCount: null,
      historyComplete: false,
      eligibility: 'hold',
    })
  })
  it('requires every expected mailbox and invalidates coverage on a late message', () => {
    const m = message('first', '2026-09-01T12:00:00.000Z')
    const evidence = [review(m, 'cold'), complete([m])]
    expect(
      project([m], evidence, { expectedMailboxIds: ['mailbox', 'historic-mailbox'] })
        .historyComplete,
    ).toBe(false)
    const late = message('late', '2026-10-29T12:00:00.000Z', 'INBOUND', 'RECEIVED')
    expect(project([m, late], [...evidence, review(late, 'human')])).toMatchObject({
      coldEmailCount: null,
      historyComplete: false,
      relationship: 'inConversation',
      eligibility: 'hold',
    })
  })
  it('deduplicates matching provider observations across retained account rows', () => {
    const m = message('first', '2026-09-01T12:00:00.000Z')
    const retained = { ...m, id: 'retained-copy', organizationId: 'retained' }
    expect(
      project(
        [m, retained],
        [review(m, 'cold'), review(retained, 'cold'), complete([m], ['org', 'retained'])],
        { organizationIds: ['org', 'retained'] },
      ),
    ).toMatchObject({ coldEmailCount: 1, historyComplete: true })
  })
  it('counts warm scheduling separately from cold and stops cadence after a human reply', () => {
    const cold = message('cold', '2026-09-01T12:00:00.000Z')
    const reply = message('reply', '2026-09-02T12:00:00.000Z', 'INBOUND', 'RECEIVED')
    const warm = message('warm', '2026-10-29T12:00:00.000Z')
    const messages = [cold, reply, warm]
    expect(
      project(messages, [
        review(cold, 'cold'),
        review(reply, 'human'),
        review(warm, 'warm'),
        complete(messages),
      ]),
    ).toMatchObject({
      coldEmailCount: 1,
      firstHumanReply: 'after1',
      relationship: 'inConversation',
      nextEligibleAt: null,
      eligibility: 'hold',
    })
  })
  it('does not treat bounce, OOO or automation as a human reply', () => {
    for (const classification of ['bounce', 'outOfOffice', 'automated']) {
      const cold = message('cold', '2026-09-01T12:00:00.000Z')
      const automated = message('inbound', '2026-09-02T12:00:00.000Z', 'INBOUND', 'RECEIVED')
      expect(
        project(
          [cold, automated],
          [review(cold, 'cold'), review(automated, classification), complete([cold, automated])],
        ),
      ).toMatchObject({
        coldEmailCount: 1,
        firstHumanReply: 'noReply',
        relationship: 'awaitingReply',
      })
    }
  })
  it('enforces the exact 21-day first follow-up boundary', () => {
    const m = message('first', '2026-10-09T12:00:00.000Z')
    const coverage = complete([m])
    ;(coverage.evidence as { coverage: { throughAt: string }[] }).coverage[0]!.throughAt =
      '2026-10-29T12:00:00.000Z'
    const evidence = [review(m, 'cold'), coverage]
    const before = project([m], evidence, { now: new Date(now.getTime() - 1) })
    expect(before.historyComplete).toBe(true)
    expect(before.reasons).toContain('cooldown')
    expect(project([m], evidence)).toMatchObject({
      eligibility: 'eligible',
      nextEligibleAt: now.toISOString(),
    })
  })
  it('clamps the second follow-up calendar month at month end', () => {
    const first = message('first', '2026-08-01T12:00:00.000Z')
    const second = message('second', '2026-08-31T12:00:00.000Z')
    const messages = [first, second]
    expect(
      project(messages, [review(first, 'cold'), review(second, 'cold'), complete(messages)]),
    ).toMatchObject({
      coldEmailCount: 2,
      nextEligibleAt: '2026-09-30T12:00:00.000Z',
      eligibility: 'eligible',
    })
  })
  it('holds duplicate drafts and stops a complete three-message cold sequence', () => {
    const messages = ['2026-07-01', '2026-08-01', '2026-09-01'].map((date, i) =>
      message(String(i), `${date}T12:00:00.000Z`),
    )
    expect(
      project(messages, [...messages.map((m) => review(m, 'cold')), complete(messages)]),
    ).toMatchObject({ coldEmailCount: 3, eligibility: 'stopped', nextEligibleAt: null })
    expect(project([], [complete([])], { hasUnsentDraft: true })).toMatchObject({
      coldEmailCount: 0,
      eligibility: 'hold',
    })
  })
  it('recognizes a late human reply after the third cold message without reopening cold outreach', () => {
    const cold = ['2026-07-01', '2026-08-01', '2026-09-01'].map((date, i) =>
      message(String(i), `${date}T12:00:00.000Z`),
    )
    const reply = message('late-reply', '2026-10-29T12:00:00.000Z', 'INBOUND', 'RECEIVED')
    const messages = [...cold, reply]
    expect(
      project(messages, [
        ...cold.map((m) => review(m, 'cold')),
        review(reply, 'human'),
        complete(messages),
      ]),
    ).toMatchObject({
      firstHumanReply: 'after3',
      relationship: 'inConversation',
      coldEmailCount: 3,
      eligibility: 'stopped',
      nextEligibleAt: null,
    })
  })
  it('retains observed Sent after delivery bounce while excluding a failed attempt without Sent evidence', () => {
    const sent = message('observed', '2026-09-01T12:00:00.000Z')
    const proof = review(sent, 'cold')
    ;(proof.evidence as Record<string, unknown>).observedSent = true
    expect(project([{ ...sent, status: 'BOUNCED' }], [proof, complete([sent])])).toMatchObject({
      coldEmailCount: 1,
      historyComplete: true,
    })
    const failed = message('attempt', '2026-09-01T12:00:00.000Z', 'OUTBOUND', 'FAILED')
    expect(project([failed], [review(failed, 'cold'), complete([])])).toMatchObject({
      coldEmailCount: 0,
      historyComplete: true,
    })
  })

  it('never counts a provider draft even when a stale classification exists', () => {
    const draft = message('draft', '2026-10-01T12:00:00.000Z', 'OUTBOUND', 'DRAFT')
    expect(project([draft], [review(draft, 'cold'), complete([])])).toMatchObject({
      coldEmailCount: 0,
      historyComplete: true,
    })
  })
  it('ignores actor-spoofed reviews and rejects stale classifications after source metadata changes', () => {
    const m = message('first', '2026-09-01T12:00:00.000Z')
    const spoof = { ...review(m, 'cold'), actorId: 'other-person' }
    expect(project([m], [spoof, complete([m])]).historyComplete).toBe(false)
    const changed = { ...m, subject: 'Changed source metadata' }
    expect(project([changed], [review(m, 'cold'), complete([changed])]).coldEmailCount).toBeNull()
  })
})

describe('canonical loader defensive review', () => {
  it('holds a merge redirect cycle even with otherwise complete reviewed history', async () => {
    const ids = ['org', 'peer']
    const proof = complete([], ids)
    const contacts = [
      {
        id: 'contact',
        archivedAt: null,
        normalizedEmail: 'venue@example.org',
        emailReadiness: 'VALID',
        permissionState: 'UNKNOWN',
      },
    ]
    const reader = {
      prospectOrganization: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          mergedIntoOrganizationId: where.id === 'org' ? 'peer' : 'org',
        })),
        findMany: vi.fn(async (args: { where: { mergedIntoOrganizationId?: { in: string[] } } }) =>
          args.where.mergedIntoOrganizationId
            ? ids.map((id) => ({ id }))
            : ids.map((id) => ({
                id,
                contacts: id === 'org' ? contacts : [],
                opportunity: null,
                customerRelationships: [],
                emailThreads: [],
              })),
        ),
      },
      prospectEmailMessage: { findMany: vi.fn(async () => []) },
      prospectActivity: { findMany: vi.fn(async () => [proof]) },
      prospectOutreachDraft: { findMany: vi.fn(async () => []) },
      correspondenceProviderAccount: {
        findMany: vi.fn(async () => [
          {
            id: 'mailbox',
            mailboxAddress: 'sender@example.com',
            connectionStatus: 'CONNECTED',
            lastSuccessfulSyncAt: now,
          },
        ]),
      },
      prospectInboundQuarantine: { findFirst: vi.fn(async () => null) },
      prospectDuplicateCandidate: { findMany: vi.fn(async () => []) },
    } as unknown as ProspectOutreachHistoryReader
    const result = await loadProspectOutreachHistory(reader, 'org', { now })
    expect(result.historyComplete).toBe(false)
    expect(result.reasons).toContain('unresolved')
  })
})
