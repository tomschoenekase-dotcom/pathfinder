import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectSendBatchAction,
  claimProspectSendOutboxAction,
  createProspectAction,
  createProspectCampaignAction,
  db,
  linkProspectConversionAction,
  recordProspectSendFailureAction,
  recordProspectSuppressionAction,
  releaseProspectSendBatchAction,
  reviewProspectOutreachDraftAction,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_PROSPECT_CRM_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('canonical CRM disposable safety', () => {
  afterAll(async () => db.$disconnect())

  it('supports multi-location conversion, immutable release, exclusive claims, ambiguity and suppression', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `crm-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const tenant = await db.tenant.create({
        data: { id: `crm-tenant-${suffix}`, name: `CRM Tenant ${suffix}`, slug: `crm-${suffix}` },
      })
      const liveVenueA = await db.venue.create({
        data: { tenantId: tenant.id, name: `Live A ${suffix}`, slug: `live-a-${suffix}` },
      })
      const liveVenueB = await db.venue.create({
        data: { tenantId: tenant.id, name: `Live B ${suffix}`, slug: `live-b-${suffix}` },
      })
      const created = await createProspectAction({
        organization: {
          canonicalName: `Canonical Prospect ${suffix}`,
          source: 'canonicalization-integration-test',
        },
        venue: { name: `Prospect A ${suffix}`, city: 'Chicago', region: 'IL' },
        contact: {
          fullName: 'Internal Recipient',
          email: `crm-internal-${suffix}@example.test`,
          source: 'integration-test',
        },
        actor,
      })
      const prospectVenueB = await db.prospectVenue.create({
        data: {
          organizationId: created.organization.id,
          name: `Prospect B ${suffix}`,
          normalizedName: `prospect b ${suffix}`,
          city: 'Evanston',
          region: 'IL',
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const first = await linkProspectConversionAction({
        organizationId: created.organization.id,
        prospectVenueId: created.venue!.id,
        tenantId: tenant.id,
        venueId: liveVenueA.id,
        actor,
      })
      const second = await linkProspectConversionAction({
        organizationId: created.organization.id,
        prospectVenueId: prospectVenueB.id,
        tenantId: tenant.id,
        venueId: liveVenueB.id,
        actor,
      })
      const replay = await linkProspectConversionAction({
        organizationId: created.organization.id,
        prospectVenueId: prospectVenueB.id,
        tenantId: tenant.id,
        venueId: liveVenueB.id,
        actor,
      })
      expect(second.relationship.id).toBe(first.relationship.id)
      expect(replay.replayed).toBe(true)
      expect(
        await db.prospectLocationConversion.count({
          where: { relationshipId: first.relationship.id, status: 'ACTIVE' },
        }),
      ).toBe(2)

      await db.prospectContact.update({
        where: { id: created.contact!.id },
        data: {
          emailReadiness: 'VALID',
          permissionState: 'LEGITIMATE_INTEREST_RECORDED',
          permissionEvidence: { reviewedBy: actor.id },
        },
      })
      const campaign = await createProspectCampaignAction({
        name: `Internal campaign ${suffix}`,
        organizationIds: [created.organization.id],
        cohortSnapshot: { organizationIds: [created.organization.id] },
        actor,
      })
      const campaignMember = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: campaign.id },
      })
      const draft = await saveProspectOutreachDraftAction({
        memberId: campaignMember.id,
        subject: 'Internal CRM safety test',
        textBody: 'This message remains inside the disposable database.',
        groundingSnapshot: { evidence: ['integration-test'] },
        actor,
      })
      await reviewProspectOutreachDraftAction({ draftId: draft.id, approve: true, actor })
      const batch = await stageProspectSendBatchAction({
        campaignId: campaign.id,
        draftIds: [draft.id],
        actor,
      })
      await approveProspectSendBatchAction({
        batchId: batch.id,
        expectedRecipientCount: batch.recipientCount,
        expectedSnapshotHash: batch.snapshotHash,
        actor,
      })
      const providerAccount = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `gmail-${suffix}`,
          mailboxAddress: `mailbox-${suffix}@example.test`,
          connectionStatus: 'CONNECTED',
          capabilities: ['SEND', 'RECEIVE', 'RECONCILE'],
          credentialReferenceId: `encrypted-credential-ref-${suffix}`,
          deliveryEnabled: true,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      await db.prospectDeliveryControl.update({
        where: { id: 'global' },
        data: {
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: [created.contact!.normalizedEmail!],
          changedBy: actor.id,
          changedReason: 'Disposable integration test only',
        },
      })
      const released = await releaseProspectSendBatchAction({
        batchId: batch.id,
        providerAccountId: providerAccount.id,
        expectedRecipientCount: batch.recipientCount,
        expectedSnapshotHash: batch.snapshotHash,
        actor,
      })
      const claims = await Promise.all([
        claimProspectSendOutboxAction({ outboxId: released.outboxIds[0]!, workerId: 'worker-a' }),
        claimProspectSendOutboxAction({ outboxId: released.outboxIds[0]!, workerId: 'worker-b' }),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const claimed = claims.find(Boolean)!
      await recordProspectSendFailureAction({
        outboxId: claimed.outboxId,
        workerId: claimed.claimOwner,
        code: 'AMBIGUOUS_SEND',
        retryable: false,
        acceptanceAmbiguous: true,
      })
      expect((await db.prospectSendBatch.findUnique({ where: { id: batch.id } }))?.status).toBe(
        'ATTENTION_REQUIRED',
      )

      const secondCampaign = await createProspectCampaignAction({
        name: `Suppression campaign ${suffix}`,
        organizationIds: [created.organization.id],
        cohortSnapshot: { organizationIds: [created.organization.id] },
        actor,
      })
      const secondCampaignMember = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: secondCampaign.id },
      })
      const secondDraft = await saveProspectOutreachDraftAction({
        memberId: secondCampaignMember.id,
        subject: 'Suppression test',
        textBody: 'This message must never reach a provider.',
        groundingSnapshot: { evidence: ['integration-test'] },
        actor,
      })
      await reviewProspectOutreachDraftAction({ draftId: secondDraft.id, approve: true, actor })
      const secondBatch = await stageProspectSendBatchAction({
        campaignId: secondCampaign.id,
        draftIds: [secondDraft.id],
        actor,
      })
      await approveProspectSendBatchAction({
        batchId: secondBatch.id,
        expectedRecipientCount: 1,
        expectedSnapshotHash: secondBatch.snapshotHash,
        actor,
      })
      const secondRelease = await releaseProspectSendBatchAction({
        batchId: secondBatch.id,
        providerAccountId: providerAccount.id,
        expectedRecipientCount: 1,
        expectedSnapshotHash: secondBatch.snapshotHash,
        actor,
      })
      await recordProspectSuppressionAction({
        contactId: created.contact!.id,
        eventType: 'UNSUBSCRIBED',
        source: 'INBOUND_MESSAGE',
        reasonCode: 'TEST_UNSUBSCRIBE',
        actor: { type: 'SYSTEM', id: 'integration-test', role: 'SYSTEM' },
      })
      expect(
        await claimProspectSendOutboxAction({
          outboxId: secondRelease.outboxIds[0]!,
          workerId: 'worker-c',
        }),
      ).toBeNull()
      expect(
        (await db.prospectSendBatch.findUnique({ where: { id: secondBatch.id } }))?.status,
      ).toBe('PARTIAL')
      expect(
        await db.prospectContactSuppressionEvent.count({
          where: { contactId: created.contact!.id },
        }),
      ).toBe(1)
    })
  })
})
