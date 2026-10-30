import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  OUTREACH_EVIDENCE_SCHEMA,
  amendProspectOutreachEvidenceAction,
  recordProspectOutreachEvidenceAction,
  planProspectOutreachEvidence,
  projectProspectOutreachHistory,
  prospectOutreachHistoryFingerprint,
  prospectOutreachMessageFingerprint,
  resolveProspectOutreachEvidence,
  type OutreachActivity,
  type OutreachMessage,
} from './prospect-outreach-history'
import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { createProspectAction } from './prospect-actions'
import { reconcileProspectObservedMessageAction } from './prospect-outreach-history'

const now = new Date('2026-10-30T12:00:00Z')
const message: OutreachMessage = {
  id: 'message',
  organizationId: 'org',
  providerAccountId: 'mailbox',
  providerMessageId: 'provider-message',
  direction: 'OUTBOUND',
  status: 'SENT',
  fromAddress: 'sender@example.test',
  toAddresses: ['contact@example.test'],
  subject: 'Fictional venue guide',
  occurredAt: new Date('2026-08-01T12:00:00Z'),
}
const base = {
  schema: OUTREACH_EVIDENCE_SCHEMA,
  reviewerId: 'reviewer',
  reviewerType: 'AGENT' as const,
  reason: 'Reviewed fictional source evidence',
}
function activity(id: string, evidence: unknown, offset = 0): OutreachActivity {
  return {
    id,
    organizationId: 'org',
    actorId: 'reviewer',
    occurredAt: new Date(now.getTime() + offset),
    evidence,
  }
}
function classification(
  id: string,
  value: 'cold' | 'warm' | 'human',
  source = message,
  offset = 0,
) {
  return activity(
    id,
    {
      ...base,
      kind: 'message',
      classification: value,
      observedSent: source.direction === 'OUTBOUND',
      binding: {
        messageId: source.id,
        providerAccountId: source.providerAccountId,
        providerMessageId: source.providerMessageId,
        fingerprint: prospectOutreachMessageFingerprint(source),
      },
    },
    offset,
  )
}
function complete(id: string, messages = [message], offset = 0) {
  return activity(
    id,
    {
      ...base,
      kind: 'complete',
      organizationIds: ['org'],
      contactIds: [],
      mailboxIds: ['mailbox'],
      historyFingerprint: prospectOutreachHistoryFingerprint(messages, ['org']),
      coverage: [
        {
          providerAccountId: 'mailbox',
          mailboxAddress: 'sender@example.test',
          searchedAt: now.toISOString(),
          throughAt: now.toISOString(),
          query: 'all fictional account history',
          sourceReceiptId: 'fictional-receipt',
          resultFingerprint: 'a'.repeat(64),
          complete: true,
        },
      ],
    },
    offset,
  )
}
function amend(
  activities: OutreachActivity[],
  targetId: string,
  id: string,
  replacement: unknown | null = null,
  offset = 10,
) {
  const target = resolveProspectOutreachEvidence(activities).versions.find(
    (item) => item.evidenceId === targetId,
  )!
  return activity(
    id,
    {
      ...base,
      kind: 'amendment',
      targetEvidenceId: targetId,
      expectedCurrentEvidenceId: target.currentEvidenceId,
      expectedFingerprint: target.fingerprint,
      replacement,
    },
    offset,
  )
}
function project(activities: OutreachActivity[], messages = [message]) {
  return projectProspectOutreachHistory({
    canonicalOrganizationId: 'org',
    organizationIds: ['org'],
    messages,
    activities,
    expectedMailboxIds: ['mailbox'],
    stages: ['CONTACTED'],
    contactHealth: 'healthy',
    customer: false,
    hasUnsentDraft: false,
    now: new Date(now.getTime() + 1000),
  })
}

describe('append-only outreach evidence corrections', () => {
  it('retracts the latest message classification without resurrecting an older value or resetting eligibility to zero', () => {
    const records = [
      classification('old', 'warm'),
      classification('latest', 'cold', message, 1),
      complete('complete', [message], 2),
    ]
    expect(project(records)).toMatchObject({ coldEmailCount: 1, eligibility: 'eligible' })
    const correction = amend(records, 'latest', 'retraction')
    const resolved = resolveProspectOutreachEvidence([...records, correction])
    expect(resolved.effective.some((item) => item.kind === 'message')).toBe(false)
    expect(resolved.versions.find((item) => item.evidenceId === 'latest')).toMatchObject({
      current: true,
      active: false,
      retracted: true,
      currentEvidenceId: 'retraction',
      revision: 2,
    })
    expect(project([...records, correction])).toMatchObject({
      coldEmailCount: null,
      historyComplete: false,
      eligibility: 'hold',
    })
    // Even a new completeness assertion cannot manufacture a classification for the observation.
    expect(
      project([...records, correction, complete('new-complete', [message], 20)]),
    ).toMatchObject({ coldEmailCount: null, eligibility: 'hold' })
  })
  it.each(['relationship', 'contactHealth', 'complete'] as const)(
    'does not reveal hidden older %s evidence after retraction',
    (kind) => {
      const value =
        kind === 'relationship'
          ? { ...base, kind, relationship: 'declined', deferUntil: null }
          : kind === 'contactHealth'
            ? {
                ...base,
                kind,
                contactId: 'contact',
                recipientAddress: 'contact@example.test',
                health: 'bounced',
                binding: {
                  messageId: message.id,
                  providerAccountId: message.providerAccountId,
                  providerMessageId: message.providerMessageId,
                  fingerprint: prospectOutreachMessageFingerprint(message),
                },
              }
            : complete('unused').evidence
      const records = [activity('old', value), activity('latest', value, 1)]
      expect(
        resolveProspectOutreachEvidence([
          ...records,
          amend(records, 'latest', 'retraction'),
        ]).effective.some((item) => item.kind === kind),
      ).toBe(false)
    },
  )
  it('holds malformed or stale amendments and keeps a real human conversation after relationship correction', () => {
    const reply = {
      ...message,
      id: 'reply',
      providerMessageId: 'provider-reply',
      direction: 'INBOUND',
      status: 'RECEIVED',
      occurredAt: new Date('2026-08-02T12:00:00Z'),
      fromAddress: 'contact@example.test',
      toAddresses: ['sender@example.test'],
    }
    const records = [
      classification('cold', 'cold'),
      classification('human', 'human', reply, 1),
      activity(
        'decline',
        { ...base, kind: 'relationship', relationship: 'declined', deferUntil: null },
        2,
      ),
      complete('complete', [message, reply], 3),
    ]
    const replacement = {
      ...base,
      kind: 'relationship',
      relationship: 'prospect',
      deferUntil: null,
    }
    const corrected = [...records, amend(records, 'decline', 'correction', replacement)]
    expect(project(corrected, [message, reply])).toMatchObject({
      relationship: 'inConversation',
      historyComplete: false,
      eligibility: 'hold',
    })
    const stale = activity(
      'stale',
      {
        ...(corrected.at(-1)!.evidence as Record<string, unknown>),
        expectedFingerprint: '0'.repeat(64),
      },
      20,
    )
    expect(resolveProspectOutreachEvidence([...corrected, stale]).invalidated).toBe(true)
  })
})

const enabled =
  process.env.RUN_PROSPECT_OUTREACH_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')
describe.skipIf(!enabled)('outreach correction disposable database', () => {
  afterAll(async () => db.$disconnect())
  it('proves revision admission, exact replay, original preservation and tombstone reads on PostgreSQL', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const human = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: `human-${suffix}`,
      }
      const agent = {
        type: 'AGENT' as const,
        id: `agent-${suffix}`,
        capabilities: ['prospects:outreach-history:reconcile'],
      }
      const prospect = await createProspectAction({
        organization: {
          canonicalName: `Fictional Correction Gallery ${suffix}`,
          source: 'disposable-test',
        },
        contact: {
          fullName: 'Casey Example',
          email: `casey-${suffix}@example.test`,
          source: 'original-fixture',
        },
        actor: human,
      })
      const mailbox = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `correction-${suffix}`,
          mailboxAddress: `archive-${suffix}@example.test`,
          capabilities: [],
          connectionStatus: 'DISCONNECTED',
          deliveryEnabled: false,
          createdBy: human.id,
          updatedBy: human.id,
        },
      })
      const observation = await reconcileProspectObservedMessageAction({
        organizationId: prospect.organization.id,
        providerAccountId: mailbox.id,
        providerMessageId: `message-${suffix}`,
        providerThreadId: `thread-${suffix}`,
        direction: 'OUTBOUND',
        occurredAt: new Date('2026-08-01T12:00:00Z'),
        fromAddress: mailbox.mailboxAddress,
        toAddresses: [prospect.contact!.normalizedEmail!],
        subject: 'Fictional visitor guide',
        providerLabelIds: ['SENT'],
        sourceReceiptId: `receipt-${suffix}`,
        sourceReceiptSha256: createHash('sha256').update(suffix).digest('hex'),
        classification: 'cold',
        actor: agent,
        dryRun: false,
      })
      const before = await planProspectOutreachEvidence(db, prospect.organization.id)
      const target = before.evidence.find(
        (item) => item.current && item.evidence?.kind === 'message',
      )!
      const original = await db.prospectActivity.findUniqueOrThrow({
        where: { id: target.evidenceId },
      })
      const originalMessage = await db.prospectEmailMessage.findUniqueOrThrow({
        where: { id: observation.messageId! },
      })
      const correctionInput = {
        organizationId: prospect.organization.id,
        operationId: randomUUID(),
        targetEvidenceId: target.evidenceId,
        expectedCurrentEvidenceId: target.currentEvidenceId,
        expectedFingerprint: target.fingerprint,
        reason:
          'The fictional classification was mistaken; retain source observation pending review',
        replacement: null,
        actor: agent,
      }
      const applied = await amendProspectOutreachEvidenceAction(correctionInput)
      expect(applied.inserted).toBe(true)
      expect(await amendProspectOutreachEvidenceAction(correctionInput)).toEqual({
        activityId: applied.activityId,
        inserted: false,
      })
      await expect(
        amendProspectOutreachEvidenceAction({ ...correctionInput, operationId: randomUUID() }),
      ).rejects.toThrow('Evidence version changed')
      await expect(
        amendProspectOutreachEvidenceAction({
          ...correctionInput,
          reason: 'Changed content under same operation',
        }),
      ).rejects.toThrow('different content')
      expect(await db.prospectActivity.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
        original,
      )
      expect(
        await db.prospectEmailMessage.findUniqueOrThrow({ where: { id: originalMessage.id } }),
      ).toEqual(originalMessage)
      const after = await planProspectOutreachEvidence(db, prospect.organization.id)
      expect(after.evidence.find((item) => item.evidenceId === target.evidenceId)).toMatchObject({
        revision: 2,
        currentEvidenceId: applied.activityId,
        retracted: true,
        active: false,
      })
      expect(after.projection).toMatchObject({
        coldEmailCount: null,
        historyComplete: false,
        eligibility: 'hold',
      })
      expect(after.messages).toHaveLength(1)
      expect(
        await db.prospectActivity.count({
          where: { externalReceiptKey: `outreach-history-amend:${correctionInput.operationId}` },
        }),
      ).toBe(1)
      // A tombstone can itself be corrected only with the current returned version.
      const tombstone = after.evidence.find((item) => item.evidenceId === target.evidenceId)!
      await expect(
        amendProspectOutreachEvidenceAction({
          ...correctionInput,
          operationId: randomUUID(),
          expectedCurrentEvidenceId: tombstone.currentEvidenceId,
          expectedFingerprint: tombstone.fingerprint,
          expectedRevision: before.revision,
        }),
      ).rejects.toThrow('Evidence revision changed')
      const restored = await amendProspectOutreachEvidenceAction({
        ...correctionInput,
        operationId: randomUUID(),
        expectedCurrentEvidenceId: tombstone.currentEvidenceId,
        expectedRevision: after.revision,
        expectedFingerprint: tombstone.fingerprint,
        replacement: target.originalEvidence,
        reason: 'Source rechecked against the exact provider message',
      })
      expect(
        (await planProspectOutreachEvidence(db, prospect.organization.id)).evidence.find(
          (item) => item.evidenceId === target.evidenceId,
        ),
      ).toMatchObject({
        revision: 3,
        currentEvidenceId: restored.activityId,
        active: true,
        retracted: false,
        evidence: { classification: 'cold', reviewerType: 'AGENT' },
      })
      await expect(
        recordProspectOutreachEvidenceAction({
          organizationId: prospect.organization.id,
          operationId: randomUUID(),
          expectedRevision: before.revision,
          actor: agent,
          evidence: {
            ...base,
            reviewerId: agent.id,
            kind: 'relationship',
            relationship: 'deferred',
            deferUntil: null,
          },
        }),
      ).rejects.toThrow('Evidence revision changed')
      const concurrentPlan = await planProspectOutreachEvidence(db, prospect.organization.id)
      const requests = (['deferred', 'declined'] as const).map((relationship) => ({
        organizationId: prospect.organization.id,
        operationId: randomUUID(),
        expectedRevision: concurrentPlan.revision,
        actor: agent,
        evidence: {
          ...base,
          reviewerId: agent.id,
          kind: 'relationship',
          relationship,
          deferUntil: null,
        },
      }))
      const outcomes = await Promise.allSettled(
        requests.map((request) => recordProspectOutreachEvidenceAction(request)),
      )
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      const winner = outcomes.findIndex((outcome) => outcome.status === 'fulfilled')
      expect(await recordProspectOutreachEvidenceAction(requests[winner]!)).toMatchObject({
        inserted: false,
      })
      expect(
        await db.prospectActivity.count({
          where: {
            organizationId: prospect.organization.id,
            summary: 'Outreach history relationship reviewed',
          },
        }),
      ).toBe(1)
    })
  }, 30_000)
})
