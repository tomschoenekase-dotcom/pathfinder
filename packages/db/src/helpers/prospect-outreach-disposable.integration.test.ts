import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  approveProspectSendBatchAction,
  claimProspectSendOutboxAction,
  createProspectAction,
  createProspectCampaignAction,
  db,
  reviewProspectOutreachDraftAction,
  revalidateProspectSendOutboxClaimAction,
  releaseProspectSendBatchAction,
  reviewProspectContactReadinessAction,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
  planProspectOutreachEvidence,
  recordProspectOutreachEvidenceAction,
  reconcileProspectObservedMessageAction,
  loadProspectOutreachHistory,
  requireProspectOutreachHistory,
} from '../index'

const enabled =
  process.env.RUN_PROSPECT_OUTREACH_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('prospect outreach disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

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
      const mailboxAddress = 'tomschoenekase@torchiko.com'
      const providerAccount = await db.correspondenceProviderAccount.upsert({
        where: { provider_mailboxAddress: { provider: 'GMAIL', mailboxAddress } },
        update: {
          capabilities: ['SEND', 'RECEIVE'],
          connectionStatus: 'CONNECTED',
          lastSuccessfulSyncAt: new Date(),
          deliveryEnabled: true,
          pausedAt: null,
        },
        create: {
          provider: 'GMAIL',
          externalAccountId: `disposable-gmail-${suffix}`,
          mailboxAddress,
          capabilities: ['SEND', 'RECEIVE'],
          connectionStatus: 'CONNECTED',
          lastSuccessfulSyncAt: new Date(),
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
      const evidencePlan = await planProspectOutreachEvidence(db, prospect.organization.id)
      const checkedAt = new Date().toISOString()
      await recordProspectOutreachEvidenceAction({
        organizationId: prospect.organization.id,
        operationId: randomUUID(),
        actor,
        evidence: {
          schema: 'prospect-outreach-history/v1',
          kind: 'complete',
          reviewerId: actor.id,
          reason: 'All disposable provider fixture mailboxes have zero historical messages',
          historyFingerprint: evidencePlan.historyFingerprint,
          organizationIds: evidencePlan.organizationIds,
          contactIds: evidencePlan.contactIds,
          mailboxIds: evidencePlan.mailboxes.map((item) => item.id),
          coverage: evidencePlan.mailboxes.map((item) => ({
            providerAccountId: item.id,
            mailboxAddress: item.mailboxAddress,
            searchedAt: checkedAt,
            throughAt: checkedAt,
            query: 'all fixture history including Sent, received and automated notices',
            sourceReceiptId: 'disposable-empty-provider-history',
            resultFingerprint: createHash('sha256').update('[]').digest('hex'),
            complete: true,
          })),
        },
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
      let draft = await saveProspectOutreachDraftAction({
        memberId: member.id,
        subject: `Torchiko for Outreach Museum ${suffix}`,
        textBody:
          'I would be happy to explain Torchiko. Pricing for a venue like yours could be $25 per month.',
        groundingSnapshot: { organizationId: prospect.organization.id, outreachKind: 'cold' },
        actor: {
          type: 'AGENT',
          id: `agent-${suffix}`,
          capabilities: ['prospects:read', 'prospects:draft'],
        },
      })
      const firstDraftId = draft.id
      draft = await saveProspectOutreachDraftAction({
        memberId: member.id,
        subject: draft.subject,
        textBody: draft.textBody,
        groundingSnapshot: { organizationId: prospect.organization.id, outreachKind: 'cold' },
        actor,
      })
      expect(draft.version).toBe(2)
      expect(
        await db.prospectOutreachDraft.findUniqueOrThrow({ where: { id: firstDraftId } }),
      ).toMatchObject({ status: 'SUPERSEDED' })
      const siblingCampaign = await createProspectCampaignAction({
        name: `Sibling campaign ${suffix}`,
        organizationIds: [prospect.organization.id],
        cohortSnapshot: { source: 'integration-test' },
        actor,
      })
      const siblingMember = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: siblingCampaign.id },
      })
      await expect(
        saveProspectOutreachDraftAction({
          memberId: siblingMember.id,
          subject: 'Another cold draft',
          textBody: 'Another cold note',
          groundingSnapshot: { outreachKind: 'cold' },
          actor,
        }),
      ).rejects.toThrow('existing_unsent_draft')
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
  it('reconciles observed Sent idempotently, preserves original contact data and keeps incomplete history held', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const actor = {
        type: 'HUMAN' as const,
        role: 'PLATFORM_ADMIN' as const,
        id: `fixture-human-${suffix}`,
      }
      const prospect = await createProspectAction({
        organization: {
          canonicalName: `Fictional Harbor Gallery ${suffix}`,
          source: 'disposable-test',
        },
        contact: {
          fullName: 'Morgan Example',
          email: `morgan-${suffix}@example.test`,
          source: 'original-source',
        },
        actor,
      })
      const contact = await db.prospectContact.findUniqueOrThrow({
        where: { id: prospect.contact!.id },
      })
      const mailbox = await db.correspondenceProviderAccount.create({
        data: {
          provider: 'GMAIL',
          externalAccountId: `observed-${suffix}`,
          mailboxAddress: `archive-${suffix}@example.test`,
          connectionStatus: 'DISCONNECTED',
          deliveryEnabled: false,
          capabilities: [],
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
      const reconcileActor = {
        type: 'AGENT' as const,
        id: `fixture-agent-${suffix}`,
        capabilities: ['prospects:outreach-history:reconcile'],
      }
      const observed = {
        organizationId: prospect.organization.id,
        providerAccountId: mailbox.id,
        providerMessageId: `sent-${suffix}`,
        providerThreadId: `thread-${suffix}`,
        direction: 'OUTBOUND' as const,
        occurredAt: new Date('2026-08-01T12:00:00Z'),
        fromAddress: mailbox.mailboxAddress,
        toAddresses: [contact.normalizedEmail!],
        subject: 'A fictional gallery guide',
        providerLabelIds: ['SENT'],
        sourceReceiptId: `fixture-receipt-${suffix}`,
        sourceReceiptSha256: createHash('sha256')
          .update('fictional-provider-observation')
          .digest('hex'),
        classification: 'cold' as const,
        actor: reconcileActor,
        dryRun: false,
      }
      const before = await db.prospectEmailMessage.count({
        where: { organizationId: prospect.organization.id },
      })
      const first = await reconcileProspectObservedMessageAction(observed)
      const second = await reconcileProspectObservedMessageAction(observed)
      expect(first.inserted).toBe(true)
      expect(second).toMatchObject({ inserted: false, messageId: first.messageId })
      expect(
        await db.prospectEmailMessage.count({
          where: { organizationId: prospect.organization.id },
        }),
      ).toBe(before + 1)
      expect(await db.prospectContact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(
        contact,
      )
      expect(await loadProspectOutreachHistory(db, prospect.organization.id)).toMatchObject({
        coldEmailCount: null,
        historyComplete: false,
        eligibility: 'hold',
      })
      await expect(
        requireProspectOutreachHistory(db, prospect.organization.id, { outreachKind: 'cold' }),
      ).rejects.toThrow('OUTREACH_HISTORY_HOLD')
      await expect(
        reconcileProspectObservedMessageAction({
          ...observed,
          providerMessageId: `draft-${suffix}`,
          providerLabelIds: ['DRAFT'],
        }),
      ).rejects.toThrow('observed provider SENT')
      await recordProspectOutreachEvidenceAction({
        organizationId: prospect.organization.id,
        operationId: randomUUID(),
        actor: reconcileActor,
        evidence: {
          schema: 'prospect-outreach-history/v1',
          kind: 'relationship',
          reviewerId: reconcileActor.id,
          reason: 'Explicit fictional recipient decline observed in reviewed source',
          relationship: 'declined',
          deferUntil: null,
        },
      })
      expect(await loadProspectOutreachHistory(db, prospect.organization.id)).toMatchObject({
        relationship: 'declined',
        eligibility: 'stopped',
      })
      const receipt = await db.prospectActivity.findFirstOrThrow({
        where: {
          organizationId: prospect.organization.id,
          summary: 'Outreach history relationship reviewed',
        },
      })
      expect(receipt.evidence).toMatchObject({
        reviewerType: 'AGENT',
        reviewerId: reconcileActor.id,
      })
    })
  })
})
