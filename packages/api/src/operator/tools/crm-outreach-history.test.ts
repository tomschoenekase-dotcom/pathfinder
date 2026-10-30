import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
const mocks = vi.hoisted(() => ({ plan: vi.fn(), record: vi.fn(), amend: vi.fn(), load: vi.fn() }))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  planProspectOutreachEvidence: mocks.plan,
  recordProspectOutreachEvidenceAction: mocks.record,
  amendProspectOutreachEvidenceAction: mocks.amend,
  loadProspectOutreachHistory: mocks.load,
}))
import { crmReadTools } from './crm'
import { getOutreachHistory } from './crm-outreach-history'
import {
  outreachHistoryReviewKind,
  outreachHistoryRetractKind,
} from '../kinds/crm-outreach-history'
import { readOutreachHistoryState } from '../outreach-history'
import type { OperatorCallContext } from '../registry'
import type { OperatorApplyContext } from '../proposals'
const projection = {
  canonicalOrganizationId: 'org-fiction',
  organizationIds: ['org-fiction'],
  coldEmailCount: 0,
  lastColdEmailAt: null,
  firstHumanReply: 'noReply',
  relationship: 'prospect',
  nextEligibleAt: null,
  eligibility: 'eligible',
  eligibilityReason: 'eligible',
  reasons: [],
  contactHealth: 'healthy',
  historyComplete: true,
}
const evidence = {
  schema: 'prospect-outreach-history/v1',
  kind: 'relationship',
  reviewerId: 'reviewer',
  reason: 'Source review',
  relationship: 'deferred',
  deferUntil: null,
}
const plan = {
  revision: 'a'.repeat(64),
  projection,
  historyFingerprint: 'a'.repeat(64),
  organizationIds: ['org-fiction'],
  contactIds: ['contact-fiction'],
  mailboxes: [
    {
      id: 'mailbox-fiction',
      mailboxAddress: 'owner@example.test',
      connectionStatus: 'CONNECTED',
      lastSuccessfulSyncAt: new Date('2026-10-30T12:00:00Z'),
    },
  ],
  messages: [1, 2].map((i) => ({
    messageId: `message-${i}`,
    providerAccountId: 'mailbox-fiction',
    providerMessageId: `provider-${i}`,
    fingerprint: String(i).repeat(64),
    direction: 'OUTBOUND',
    status: 'SENT',
    occurredAt: '2026-10-01T12:00:00Z',
    subject: 'Sample subject',
    toAddresses: ['recipient@example.test'],
    fromAddress: 'owner@example.test',
  })),
  evidence: [1, 2].map((i) => ({
    evidenceId: `evidence-${i}`,
    currentEvidenceId: `evidence-${i}`,
    fingerprint: String(i).repeat(64),
    revision: 0,
    current: true,
    active: true,
    retracted: false,
    evidence,
    originalEvidence: evidence,
    provenance: {
      actorId: 'reviewer',
      occurredAt: '2026-10-30T12:00:00Z',
      organizationId: 'org-fiction',
    },
  })),
}
const organization =
  vi.fn<
    (args: {
      where: { id: string }
    }) => Promise<{ id: string; conversion: null; customerRelationships: { tenantId: string }[] }>
  >()
const receipt = vi.fn()
const context = {
  database: {
    prospectOrganization: { findUnique: organization },
    prospectActivity: { findUnique: receipt },
  },
  grant: {
    grantId: 'grant-fiction',
    userId: 'owner-fiction',
    allTenants: true,
    tenantIds: [],
    capabilities: ['crm:read', 'crm:propose'],
  },
  now: new Date('2026-10-30T12:00:00Z'),
  actor: { type: 'HUMAN', id: 'owner-fiction', role: 'PLATFORM_ADMIN' },
  proposalId: 'proposal-fiction',
  operationId: '6d02de37-32d7-4481-bd73-564801bcd792',
} as unknown as OperatorCallContext & OperatorApplyContext
beforeEach(() => {
  vi.clearAllMocks()
  organization.mockResolvedValue({ id: 'org-fiction', conversion: null, customerRelationships: [] })
  mocks.plan.mockResolvedValue(plan)
  mocks.record.mockResolvedValue({ activityId: 'receipt-fiction', inserted: true })
  mocks.amend.mockResolvedValue({ activityId: 'amend-fiction', inserted: true })
})
describe('operator outreach history workflow', () => {
  it('returns bounded source-bound choices and ready revision/operation args without message bodies', async () => {
    const result = (await getOutreachHistory.handler(
      { organizationId: 'org-fiction', limit: 1 },
      context,
    )) as {
      revision: string
      evidence: { items: unknown[]; nextCursor: string | null }
      reviewPlan: {
        messages: { review: { operationId: string; expectedRevision: string } }[]
        messageNextCursor: string | null
      }
    }
    expect(OPERATOR_MCP_OUTPUTS['crm.get_outreach_history'].parse(result)).toEqual(result)
    expect(result.evidence.items).toHaveLength(1)
    expect(result.evidence.nextCursor).toBe('evidence-1')
    expect(result.reviewPlan.messages).toHaveLength(1)
    expect(result.reviewPlan.messageNextCursor).toBe('message-1')
    expect(result.reviewPlan.messages[0].review.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.reviewPlan.messages[0].review.expectedRevision).toBe(result.revision)
    expect(JSON.stringify(result)).not.toContain('recipient@example.test')
    expect(JSON.stringify(result)).not.toContain('textBody')
    await expect(
      getOutreachHistory.handler({ organizationId: 'org-fiction', cursor: 'foreign' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
  it('builds bindings server-side and attributes autonomous evidence to the agent, never a forged human', async () => {
    const { revision } = await readOutreachHistoryState(context.database, 'org-fiction')
    const args = OPERATOR_MCP_INPUTS['crm.propose_outreach_history_review'].parse({
      organizationId: 'org-fiction',
      expectedRevision: revision,
      reason: 'Reviewed actual source',
      change: { kind: 'message', messageId: 'message-1', classification: 'cold' },
      operationId: context.operationId,
    })
    const result = await outreachHistoryReviewKind.apply(args, context)
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: revision,
        actor: expect.objectContaining({ type: 'AGENT', id: 'operator:grant-fiction' }),
        evidence: expect.objectContaining({
          reviewerType: 'AGENT',
          binding: {
            messageId: 'message-1',
            providerAccountId: 'mailbox-fiction',
            providerMessageId: 'provider-1',
            fingerprint: '1'.repeat(64),
          },
        }),
      }),
      context.database,
    )
    expect(result.result).toMatchObject({ receiptId: 'receipt-fiction', projection })
  })
  it('soft retracts only the current evidence version and reconciles the amendment receipt', async () => {
    const { revision } = await readOutreachHistoryState(context.database, 'org-fiction')
    const args = OPERATOR_MCP_INPUTS['crm.propose_outreach_history_retract'].parse({
      organizationId: 'org-fiction',
      expectedRevision: revision,
      targetEvidenceId: 'evidence-1',
      reason: 'Mistaken review',
      operationId: context.operationId,
    })
    await outreachHistoryRetractKind.apply(args, context)
    expect(mocks.amend).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEvidenceId: 'evidence-1',
        expectedCurrentEvidenceId: 'evidence-1',
        expectedFingerprint: '1'.repeat(64),
        replacement: null,
        actor: expect.objectContaining({ type: 'AGENT' }),
      }),
      context.database,
    )
    receipt.mockResolvedValueOnce({ id: 'amend-fiction', organizationId: 'org-fiction' })
    expect(await outreachHistoryRetractKind.reconcile!(args, context)).toMatchObject({
      state: 'applied',
    })
    expect(receipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { externalReceiptKey: `outreach-history-amend:${context.operationId}` },
      }),
    )
  })
  it('changes the revision when canonical evidence changes', async () => {
    const first = await readOutreachHistoryState(context.database, 'org-fiction')
    mocks.plan.mockResolvedValueOnce({
      ...plan,
      revision: 'b'.repeat(64),
      evidence: [...plan.evidence, { ...plan.evidence[0], currentEvidenceId: 'new-version' }],
    })
    expect((await readOutreachHistoryState(context.database, 'org-fiction')).revision).not.toBe(
      first.revision,
    )
  })
  it('never clears a policy history hold merely because the address is valid', async () => {
    const contact = {
      id: 'contact-fiction',
      organizationId: 'org-fiction',
      normalizedEmail: 'person@example.test',
      email: 'person@example.test',
      emailReadiness: 'VALID',
      permissionState: 'UNKNOWN',
      doNotContact: false,
      suppressedAt: null,
      unsubscribedAt: null,
      complainedAt: null,
      lastHardBounceAt: null,
      archivedAt: null,
      organization: { archivedAt: null, opportunity: null },
    }
    const database = {
      ...context.database,
      prospectContact: { findMany: vi.fn(async () => [contact]) },
    }
    mocks.load.mockResolvedValueOnce({
      ...projection,
      eligibility: 'stopped',
      eligibilityReason: 'contact_policyBlocked',
      contactHealth: 'policyBlocked',
    })
    const tool = crmReadTools.find((item) => item.name === 'crm.check_can_contact')!
    const result = await tool.handler({ email: 'person@example.test', purpose: 'draft' }, {
      ...context,
      database,
    } as unknown as OperatorCallContext)
    expect(result).toMatchObject({
      allowed: false,
      addressAllowed: true,
      coldOutreachAllowed: false,
      reason: 'outreach_history_hold',
      outreachHistory: { contactHealth: 'policyBlocked' },
    })
    expect(OPERATOR_MCP_OUTPUTS['crm.check_can_contact'].safeParse(result).success).toBe(true)
  })
  it('refuses a canonical group whose other member links to an ungranted tenant', async () => {
    mocks.plan.mockResolvedValueOnce({ ...plan, organizationIds: ['org-fiction', 'org-private'] })
    organization.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      conversion: null,
      customerRelationships: where.id === 'org-private' ? [{ tenantId: 'tenant-private' }] : [],
    }))
    await expect(
      getOutreachHistory.handler({ organizationId: 'org-fiction', limit: 1 }, {
        ...context,
        grant: { ...context.grant, allTenants: false, tenantIds: [] },
      } as unknown as OperatorCallContext),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
