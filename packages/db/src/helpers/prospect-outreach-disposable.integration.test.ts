import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectSendBatchAction,
  claimProspectSendOutboxAction,
  createProspectAction,
  createProspectCampaignAction,
  db,
  importExistingProspectGmailDraftAction,
  reviewProspectOutreachDraftAction,
  revalidateProspectSendOutboxClaimAction,
  releaseProspectSendBatchAction,
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

  it('persists one immutable existing Gmail draft link and reopens the same native draft on retry', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        id: `admin-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const email = `review-${suffix}@example.test`
      const mailboxAddress = `gmail-link-${suffix}@example.test`
      const prospect = await createProspectAction({
        organization: { canonicalName: `Gmail Link Museum ${suffix}`, source: 'disposable-test' },
        venue: { name: `Gmail Link Museum ${suffix}`, city: 'Chicago', region: 'IL' },
        contact: { fullName: 'Avery Example', email, source: 'disposable-test' },
        actor,
      })
      const campaign = await createProspectCampaignAction({
        name: `Gmail Link Campaign ${suffix}`,
        organizationIds: [prospect.organization.id],
        cohortSnapshot: { source: 'disposable-test' },
        actor,
      })
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: campaign.id, organizationId: prospect.organization.id },
      })
      const account = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `disposable-gmail-link-${suffix}`,
          mailboxAddress,
          capabilities: [],
          connectionStatus: 'CONNECTED',
          credentialReferenceId: `fake-credential-reference-${suffix}`,
          lastReconciliationAt: new Date(),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const input = {
        memberId: member.id,
        providerAccountId: account.id,
        providerDraftId: `stable-draft-${suffix}`,
        providerMessageId: `message-${suffix}`,
        fromEmail: mailboxAddress,
        toEmail: email,
        subject: `Torchiko at Gmail Link Museum ${suffix}`,
        textBody: 'Hi, I am Tom Schoenekase. How could a visitor explore this museum?',
        historyReviewConfirmed: true as const,
        actor,
      }
      const first = await importExistingProspectGmailDraftAction(input)
      expect(first.idempotent).toBe(false)
      expect(first.draft.status).toBe('NEEDS_REVIEW')
      const saved = await db.prospectOutreachDraftGmailLink.findUniqueOrThrow({
        where: {
          providerAccountId_providerDraftId: {
            providerAccountId: account.id,
            providerDraftId: input.providerDraftId,
          },
        },
        include: { outreachDraft: true },
      })
      expect(saved).toMatchObject({
        id: first.link.id,
        providerMessageId: input.providerMessageId,
        verificationStatus: 'VERIFIED',
        contentHash: first.draft.contentHash,
        outreachDraft: { id: first.draft.id, toEmail: email, textBody: input.textBody },
      })
      const retry = await importExistingProspectGmailDraftAction({
        ...input,
        providerMessageId: `rotated-message-${suffix}`,
      })
      expect(retry).toMatchObject({ idempotent: true, messageIdDrifted: true })
      expect(retry.draft.id).toBe(first.draft.id)
      expect(retry.link.id).toBe(saved.id)
      await expect(
        importExistingProspectGmailDraftAction({
          ...input,
          textBody: 'Changed body must not replace the retained draft.',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.$executeRawUnsafe(
          'UPDATE "prospect_outreach_draft_gmail_links" SET "provider_message_id" = $1 WHERE "id" = $2',
          `tampered-${suffix}`,
          saved.id,
        ),
      ).rejects.toThrow()
      await expect(
        db.$executeRawUnsafe(
          'DELETE FROM "prospect_outreach_draft_gmail_links" WHERE "id" = $1',
          saved.id,
        ),
      ).rejects.toThrow()
      expect(
        await db.prospectOutreachDraftGmailLink.findUniqueOrThrow({ where: { id: saved.id } }),
      ).toMatchObject({
        providerMessageId: input.providerMessageId,
        contentHash: saved.contentHash,
      })
      expect(
        await db.prospectOutreachDraftGmailLink.count({
          where: { providerAccountId: account.id, providerDraftId: input.providerDraftId },
        }),
      ).toBe(1)
    })
  }, 30_000)

  it('proves review-gated release and a late-synced reply stops a claimed item before any provider call', async () => {
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
        evidence: {
          reviewReason: 'Disposable contact fixture reviewed for internal outreach testing.',
          source: 'disposable-test',
          reviewedFor: 'internal-fixture',
        },
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

      const contactId = prospect.contact?.id
      const recipientEmail = prospect.contact?.email
      if (!contactId || !recipientEmail)
        throw new Error('Disposable prospect fixture requires contact')
      const mailboxAddress = 'tomschoenekase@torchiko.com'
      const providerAccount = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `disposable-gmail-${suffix}`,
          mailboxAddress,
          capabilities: ['SEND'],
          connectionStatus: 'CONNECTED',
          credentialReferenceId: `fake-credential-reference-${suffix}`,
          deliveryEnabled: true,
          dailySendCap: 10,
          perDomainDailyCap: 2,
          minimumDelaySeconds: 0,
          jitterSeconds: 0,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      await db.prospectDeliveryControl.upsert({
        where: { id: 'global' },
        create: {
          id: 'global',
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: [recipientEmail],
          changedBy: actor.id,
          changedReason: 'Disposable internal-only reply-before-send fixture',
        },
        update: {
          deliveryEnabled: true,
          internalOnly: true,
          internalAllowlist: [recipientEmail],
          changedBy: actor.id,
          changedReason: 'Disposable internal-only reply-before-send fixture',
        },
      })
      const released = await releaseProspectSendBatchAction({
        batchId: frozen.id,
        providerAccountId: providerAccount.id,
        expectedRecipientCount: 1,
        expectedSnapshotHash: frozen.snapshotHash,
        actor,
      })
      const outbox = await db.prospectSendOutbox.findFirstOrThrow({
        where: { sendItem: { batchId: released.batch.id } },
      })
      const claimed = await claimProspectSendOutboxAction({
        outboxId: outbox.id,
        workerId: `provider-dark-worker-${suffix}`,
      })
      expect(claimed).toMatchObject({ outboxId: outbox.id, provider: 'GMAIL' })

      const item = await db.prospectSendItem.findUniqueOrThrow({
        where: { id: outbox.sendItemId },
        select: { createdAt: true },
      })
      const replyCreatedAt = new Date(item.createdAt.valueOf() + 1_000)
      const replyOccurredAt = new Date(item.createdAt.valueOf() - 86_400_000)
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId: prospect.organization.id,
          contactId,
          replyTokenHash: createHash('sha256').update(`reply-token-${suffix}`).digest('hex'),
          subject: 'Reply before provider delivery',
          lastMessageAt: replyOccurredAt,
        },
      })
      const inbound = await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId: prospect.organization.id,
          contactId,
          direction: 'INBOUND',
          status: 'RECEIVED',
          providerAccountId: providerAccount.id,
          providerMessageId: `late-synced-reply-${suffix}`,
          fromAddress: recipientEmail,
          toAddresses: [mailboxAddress],
          subject: 'Reply before provider delivery',
          textBody: 'Please do not send this message.',
          bodyPreview: 'Please do not send this message.',
          bodyRetentionState: 'TEMPORARY',
          bodyExpiresAt: new Date(replyCreatedAt.valueOf() + 86_400_000),
          sourceReference: `disposable://late-sync/${suffix}`,
          occurredAt: replyOccurredAt,
          createdAt: replyCreatedAt,
        },
      })

      await expect(
        revalidateProspectSendOutboxClaimAction({
          outboxId: outbox.id,
          workerId: `provider-dark-worker-${suffix}`,
          now: new Date(replyCreatedAt.valueOf() + 1_000),
        }),
      ).resolves.toBe(false)
      await expect(
        db.prospectSendOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        lastErrorCode: 'REPLY_RECEIVED_BEFORE_PROVIDER',
      })
      await expect(
        db.prospectSendItem.findUniqueOrThrow({ where: { id: outbox.sendItemId } }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        lastErrorCode: 'REPLY_RECEIVED_BEFORE_PROVIDER',
      })
      await expect(
        db.prospectSendBatch.findUniqueOrThrow({ where: { id: frozen.id } }),
      ).resolves.toMatchObject({
        status: 'PARTIAL',
      })
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id, direction: 'INBOUND', id: inbound.id },
        }),
      ).toBe(1)
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id, direction: 'OUTBOUND' },
        }),
      ).toBe(0)

      // Synthetic fixture state: a prior provider attempt may have been accepted before this
      // retry. Claim/takeover must retain ambiguity rather than assert that no provider delivery
      // could have occurred.
      const retryWorker = `provider-dark-retry-worker-${suffix}`
      const retryNow = new Date(replyCreatedAt.valueOf() + 2_000)
      await db.prospectSendItem.update({
        where: { id: outbox.sendItemId },
        data: { status: 'QUEUED', lastErrorCode: null, lastErrorMessage: null },
      })
      await db.prospectSendOutbox.update({
        where: { id: outbox.id },
        data: {
          status: 'RETRYABLE',
          availableAt: retryNow,
          claimOwner: null,
          claimExpiresAt: null,
          attemptCount: 1,
          terminalAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorRetryable: null,
        },
      })
      await expect(
        claimProspectSendOutboxAction({
          outboxId: outbox.id,
          workerId: retryWorker,
          now: retryNow,
        }),
      ).resolves.toBeNull()
      await expect(
        db.prospectSendOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
      ).resolves.toMatchObject({ status: 'AMBIGUOUS' })
      await expect(
        db.prospectSendItem.findUniqueOrThrow({ where: { id: outbox.sendItemId } }),
      ).resolves.toMatchObject({ status: 'AMBIGUOUS' })
      await expect(
        db.prospectSendBatch.findUniqueOrThrow({ where: { id: frozen.id } }),
      ).resolves.toMatchObject({
        status: 'ATTENTION_REQUIRED',
      })

      // A separately constructed claimed retry state covers the last pre-provider revalidation
      // boundary as well as claim/takeover above.
      await db.prospectSendItem.update({
        where: { id: outbox.sendItemId },
        data: { status: 'QUEUED', lastErrorCode: null, lastErrorMessage: null },
      })
      await db.prospectSendOutbox.update({
        where: { id: outbox.id },
        data: {
          status: 'CLAIMED',
          claimOwner: retryWorker,
          claimExpiresAt: new Date(retryNow.valueOf() + 60_000),
          attemptCount: 2,
          terminalAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastErrorRetryable: null,
        },
      })
      await expect(
        revalidateProspectSendOutboxClaimAction({
          outboxId: outbox.id,
          workerId: retryWorker,
          now: retryNow,
        }),
      ).resolves.toBe(false)
      await expect(
        db.prospectSendOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
      ).resolves.toMatchObject({ status: 'AMBIGUOUS' })
      await expect(
        db.prospectSendItem.findUniqueOrThrow({ where: { id: outbox.sendItemId } }),
      ).resolves.toMatchObject({ status: 'AMBIGUOUS' })
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id, direction: 'INBOUND', id: inbound.id },
        }),
      ).toBe(1)
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id, direction: 'OUTBOUND' },
        }),
      ).toBe(0)
    })
  }, 30_000)
})
