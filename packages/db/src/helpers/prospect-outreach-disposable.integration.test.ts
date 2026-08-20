import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectSendBatchAction,
  createProspectAction,
  createProspectCampaignAction,
  db,
  reviewProspectOutreachDraftAction,
  reviewProspectContactReadinessAction,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_PROSPECT_OUTREACH_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('prospect outreach disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('proves agent draft, escalation acknowledgment and exact frozen batch approval', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const prospect = await createProspectAction({
        organization: { canonicalName: `Outreach Museum ${suffix}`, source: 'disposable-test' },
        venue: { name: `Outreach Museum ${suffix}`, city: 'Chicago', region: 'IL' },
        contact: {
          fullName: 'Avery Example',
          email: `avery-${suffix}@example.test`,
          source: 'disposable-test',
        },
        actor,
      })
      await reviewProspectContactReadinessAction({
        contactId: prospect.contact!.id,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: { source: 'disposable-test', reviewedFor: 'internal-fixture' },
        actor,
      })
      const campaign = await createProspectCampaignAction({
        name: `Campaign ${suffix}`,
        organizationIds: [prospect.organization.id],
        cohortSnapshot: { source: 'integration-test' },
        actor,
      })
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: campaign.id, organizationId: prospect.organization.id },
      })
      const draft = await saveProspectOutreachDraftAction({
        memberId: member.id,
        subject: `Torchiko for Outreach Museum ${suffix}`,
        textBody:
          'I would be happy to explain Torchiko. Pricing for a venue like yours could be $25 per month.',
        groundingSnapshot: { organizationId: prospect.organization.id },
        actor: {
          type: 'AGENT',
          id: `agent-${suffix}`,
          capabilities: ['prospects:read', 'prospects:draft'],
        },
      })
      expect(draft.escalationFlags).toEqual(['pricing'])
      await expect(
        reviewProspectOutreachDraftAction({ draftId: draft.id, approve: true, actor }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
      const approved = await reviewProspectOutreachDraftAction({
        draftId: draft.id,
        approve: true,
        acknowledgedEscalations: ['pricing'],
        actor,
      })
      expect(approved.status).toBe('APPROVED')
      const batch = await stageProspectSendBatchAction({
        campaignId: campaign.id,
        draftIds: [draft.id],
        actor,
      })
      await expect(
        approveProspectSendBatchAction({
          batchId: batch.id,
          expectedRecipientCount: 2,
          expectedSnapshotHash: batch.snapshotHash,
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const frozen = await approveProspectSendBatchAction({
        batchId: batch.id,
        expectedRecipientCount: 1,
        expectedSnapshotHash: batch.snapshotHash,
        actor,
      })
      expect(frozen.status).toBe('APPROVED')
      expect(
        await db.prospectSendItem.count({ where: { batchId: batch.id, status: 'STAGED' } }),
      ).toBe(1)
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id },
        }),
      ).toBe(0)
    })
  }, 30_000)
})
