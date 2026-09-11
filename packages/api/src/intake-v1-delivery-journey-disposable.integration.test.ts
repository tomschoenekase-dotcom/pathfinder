import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({ ensureOrganizationInvitation: vi.fn() }))

vi.mock('@pathfinder/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/auth')>()
  return { ...actual, ensureOrganizationInvitation: authMocks.ensureOrganizationInvitation }
})

vi.mock('@pathfinder/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/ai')>()
  return {
    ...actual,
    AI_EMBEDDING_MODEL_KEYS: {
      PLACE_CONTENT: 'place-content',
      KNOWLEDGE_CONTENT: 'knowledge-content',
    },
    getAiEmbeddingProfile: (key: string) => `delivery-fixture:${key}`,
    generateEmbeddings: vi.fn(async ({ texts, usageSink }) => {
      await usageSink({
        provider: 'integration-test',
        model: 'deterministic-embedding',
        pricingVersion: 'test-v1',
        usage: {
          inputTokens: texts.length,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        estimatedCostUsd: 0,
        latencyMs: 1,
        attempts: 1,
        success: true,
      })
      return {
        embeddings: texts.map((text: string, index: number) => {
          const vector = Array(1_536).fill(0)
          vector[(text.length + index) % vector.length] = 1
          return vector
        }),
      }
    }),
  }
})
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import { getTenantBillingOverview } from '@pathfinder/billing'
import {
  db,
  linkProspectConversionAction,
  prepareCustomerAccessRequestAction,
  recordApprovalDecisionAction,
  reviewProspectInboundReplyAction,
  submitIntakeV1Action,
  submitOnboardingBootstrapAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import type { TRPCContext } from './context'
import { buildIntakeV1PackageCandidate } from './lib/intake-v1-package-candidate'
import { createIntakeV1PackageDraftForAdmin } from './lib/intake-v1-package-draft'
import { loadReviewableVenuePackageEvaluationPreview } from './lib/reviewable-package-evaluation'
import { adminEvaluationOnboardingActionsRouter } from './routers/admin/evaluation-onboarding-actions'
import { readProspectOnboardingDeliveryAttempt } from './routers/admin/prospect-crm-delivery-read'
import { portalRouter } from './routers/portal'
import { appRouter } from './root'

const confirmation = 'pathfinder_disposable_intake_v1_delivery'
const enabled =
  process.env.RUN_INTAKE_V1_DELIVERY_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_INTAKE_V1_DELIVERY_CONFIRMATION === confirmation

function assertDisposableBoundary() {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '')
  const directDatabaseUrl = new URL(process.env.DIRECT_DATABASE_URL ?? '')
  if (
    databaseUrl.toString() !== directDatabaseUrl.toString() ||
    !['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname) ||
    !databaseUrl.port ||
    !/^\/pathfinder_disposable_intake_v1_delivery_[a-z0-9_]+$/u.test(databaseUrl.pathname)
  )
    throw new Error('Fixture requires one exact-name disposable loopback database.')
}

describe.skipIf(!enabled)('V1 provider-dark delivery preparation journey', () => {
  afterAll(async () => db.$disconnect())

  it('connects an immutable V1 handoff to review and held portal preparation', async () => {
    assertDisposableBoundary()
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-v1-delivery-${suffix}`
      const ownerUserId = `owner-v1-delivery-${suffix}`
      const foreignTenantId = `tenant-v1-delivery-foreign-${suffix}`
      const foreignVenueId = `venue-v1-delivery-foreign-${suffix}`
      const prospectActor = {
        type: 'HUMAN' as const,
        id: ownerUserId,
        role: 'PLATFORM_ADMIN' as const,
      }
      const operationDurationsMs: Record<string, number> = {}
      let operationCount = 0
      const measured = async <T>(name: string, action: () => Promise<T>) => {
        const startedAt = performance.now()
        const value = await action()
        operationDurationsMs[name] = Math.round((performance.now() - startedAt) * 100) / 100
        operationCount += 1
        return value
      }

      await db.tenant.create({
        data: { id: tenantId, name: 'V1 delivery fixture', slug: tenantId },
      })
      await db.tenant.create({
        data: { id: foreignTenantId, name: 'Foreign delivery fixture', slug: foreignTenantId },
      })
      await db.user.create({
        data: { id: ownerUserId, email: `${ownerUserId}@example.test`, fullName: 'V1 owner' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'OWNER', joinedAt: new Date() },
      })
      const prospectOrganization = await db.prospectOrganization.create({
        data: {
          canonicalName: `Delivery Museum Group ${suffix}`,
          normalizedName: `delivery museum group ${suffix}`,
          source: 'disposable-intake-v1-delivery',
          createdBy: ownerUserId,
          updatedBy: ownerUserId,
        },
      })
      const prospectVenues = await Promise.all(
        ['Delivery Museum', 'Sibling Museum'].map((name) =>
          db.prospectVenue.create({
            data: {
              organizationId: prospectOrganization.id,
              name: `${name} ${suffix}`,
              normalizedName: `${name.toLowerCase()} ${suffix}`,
              createdBy: ownerUserId,
              updatedBy: ownerUserId,
            },
          }),
        ),
      )
      const prospectEmail = `delivery-guide-${suffix}@example.test`
      const prospectContact = await db.prospectContact.create({
        data: {
          organizationId: prospectOrganization.id,
          venueId: null,
          fullName: 'Avery Guide',
          email: prospectEmail,
          normalizedEmail: prospectEmail,
          source: 'disposable-intake-v1-delivery',
          createdBy: ownerUserId,
          updatedBy: ownerUserId,
        },
      })
      const prospectMessages = []
      for (const prospectVenue of prospectVenues) {
        const thread = await db.prospectEmailThread.create({
          data: {
            organizationId: prospectOrganization.id,
            venueId: prospectVenue.id,
            contactId: prospectContact.id,
            replyTokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
          },
        })
        prospectMessages.push(
          await db.prospectEmailMessage.create({
            data: {
              threadId: thread.id,
              organizationId: prospectOrganization.id,
              venueId: prospectVenue.id,
              contactId: prospectContact.id,
              direction: 'INBOUND',
              status: 'RECEIVED',
              fromAddress: prospectEmail,
              toAddresses: ['founder@example.test'],
              subject: `Interested in ${prospectVenue.name}`,
              bodyRetentionState: 'NOT_STORED',
              sourceReference: `gmail://message/${prospectVenue.id}`,
              occurredAt: new Date(),
            },
          }),
        )
      }
      const positiveInterestInput = {
        operationId: randomUUID(),
        messageId: prospectMessages[0]!.id,
        disposition: 'POSITIVE_INTEREST' as const,
        reason: 'Human review confirmed interest in onboarding this exact venue.',
        actor: prospectActor,
      }
      const positiveInterestConcurrent = await Promise.all([
        reviewProspectInboundReplyAction(positiveInterestInput),
        reviewProspectInboundReplyAction(positiveInterestInput),
      ])
      expect(positiveInterestConcurrent.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ])
      const positiveInterest = positiveInterestConcurrent[0]!
      const invitationDraft = positiveInterest.deliveryAttempt!
      expect(
        new Set(positiveInterestConcurrent.map((result) => result.deliveryAttempt!.id)),
      ).toEqual(new Set([invitationDraft.id]))
      const invitationDraftRead = await readProspectOnboardingDeliveryAttempt({
        organizationId: prospectOrganization.id,
        prospectVenueId: prospectVenues[0]!.id,
        messageId: prospectMessages[0]!.id,
      })
      expect(invitationDraftRead).toMatchObject({
        id: invitationDraft.id,
        status: 'DRAFT',
        recipientEmailSnapshot: prospectEmail,
        sourceMessageId: prospectMessages[0]!.id,
      })
      await expect(
        readProspectOnboardingDeliveryAttempt({
          organizationId: prospectOrganization.id,
          prospectVenueId: prospectVenues[1]!.id,
          messageId: prospectMessages[0]!.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const invitationRetry = await reviewProspectInboundReplyAction({
        operationId: randomUUID(),
        messageId: prospectMessages[0]!.id,
        disposition: 'POSITIVE_INTEREST',
        reason: 'A second human review confirms the same exact venue scope.',
        actor: prospectActor,
      })
      expect(invitationRetry.deliveryAttempt).toMatchObject({
        id: invitationDraft.id,
        subject: invitationDraft.subject,
        textBody: invitationDraft.textBody,
      })
      const negativeReclassification = await reviewProspectInboundReplyAction({
        operationId: randomUUID(),
        messageId: prospectMessages[0]!.id,
        disposition: 'NOT_INTERESTED',
        reason: 'The latest human review withdraws the positive-interest classification.',
        actor: prospectActor,
      })
      expect(negativeReclassification.deliveryAttempt).toBeNull()
      await expect(
        readProspectOnboardingDeliveryAttempt({
          organizationId: prospectOrganization.id,
          prospectVenueId: prospectVenues[0]!.id,
          messageId: prospectMessages[0]!.id,
        }),
      ).resolves.toMatchObject({
        id: invitationDraft.id,
        currentReview: {
          id: negativeReclassification.review.id,
          disposition: 'NOT_INTERESTED',
          state: 'HELD',
        },
        deliveryAuthorization: 'NOT_GRANTED_BY_DRAFT',
      })
      const restoredPositiveInterest = await reviewProspectInboundReplyAction({
        operationId: randomUUID(),
        messageId: prospectMessages[0]!.id,
        disposition: 'POSITIVE_INTEREST',
        reason: 'The latest human review restores positive interest for the exact venue.',
        actor: prospectActor,
      })
      expect(restoredPositiveInterest.deliveryAttempt).toMatchObject({ id: invitationDraft.id })
      await expect(
        readProspectOnboardingDeliveryAttempt({
          organizationId: prospectOrganization.id,
          prospectVenueId: prospectVenues[0]!.id,
          messageId: prospectMessages[0]!.id,
        }),
      ).resolves.toMatchObject({
        id: invitationDraft.id,
        currentReview: {
          id: restoredPositiveInterest.review.id,
          disposition: 'POSITIVE_INTEREST',
          state: 'POSITIVE_INTEREST',
        },
        deliveryAuthorization: 'NOT_GRANTED_BY_DRAFT',
      })
      const siblingPositiveInterest = await reviewProspectInboundReplyAction({
        operationId: randomUUID(),
        messageId: prospectMessages[1]!.id,
        disposition: 'POSITIVE_INTEREST',
        reason: 'Human review confirms interest for the sibling venue only.',
        actor: prospectActor,
      })
      expect(siblingPositiveInterest.deliveryAttempt).toMatchObject({
        prospectVenueId: prospectVenues[1]!.id,
        sourceMessageId: prospectMessages[1]!.id,
      })
      expect(siblingPositiveInterest.deliveryAttempt!.id).not.toBe(invitationDraft.id)
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'OWNER' as const }
      const bootstrap = await measured('collect', () =>
        submitOnboardingBootstrapAction({
          tenantId,
          actor,
          submission: {
            requestId: randomUUID(),
            venue: {
              name: 'Delivery museum',
              slug: `delivery-museum-${suffix}`,
              guideMode: 'non_location',
            },
            rawContent: {
              kind: 'knowledge',
              value: {
                title: 'Step-free entrance',
                category: 'ACCESSIBILITY',
                content: 'The east entrance is step-free.',
              },
            },
          },
        }),
      )
      const venueId = bootstrap.venue.id
      const conversion = await linkProspectConversionAction({
        organizationId: prospectOrganization.id,
        prospectVenueId: prospectVenues[0]!.id,
        tenantId,
        venueId,
        evidence: {
          sourceMessageId: prospectMessages[0]!.id,
          onboardingDeliveryAttemptId: invitationDraft.id,
        },
        actor: prospectActor,
      })
      expect(conversion).toMatchObject({
        replayed: false,
        locationConversion: {
          prospectVenueId: prospectVenues[0]!.id,
          venueId,
          status: 'ACTIVE',
        },
      })
      const conversionReplay = await linkProspectConversionAction({
        organizationId: prospectOrganization.id,
        prospectVenueId: prospectVenues[0]!.id,
        tenantId,
        venueId,
        evidence: { retry: true },
        actor: prospectActor,
      })
      expect(conversionReplay).toMatchObject({
        replayed: true,
        locationConversion: { id: conversion.locationConversion!.id },
      })
      await db.venue.create({
        data: {
          id: foreignVenueId,
          tenantId: foreignTenantId,
          name: 'Foreign delivery venue',
          slug: foreignVenueId,
        },
      })
      const submitted = await measured('freeze-v1', () =>
        submitIntakeV1Action({
          tenantId,
          venueId,
          ownerUserId,
          actorRole: 'OWNER',
          selection: {
            operationId: randomUUID(),
            partialAcknowledged: false,
            drafts: {},
            intakeRunIds: [bootstrap.runId],
            intakeUploadIds: [],
          },
        }),
      )
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { tenantId, venueId, submissionId: submitted.submissionId, revision: 1 },
        include: { members: true },
      })
      const memberId = revision.members[0]!.id
      const candidate = await measured('preview-candidate', () =>
        buildIntakeV1PackageCandidate({
          db,
          tenantId,
          venueId,
          submissionId: submitted.submissionId,
          revision: 1,
          selectedMemberIds: [memberId],
        }),
      )
      expect(candidate.ready).toBe(true)

      const draftOperationId = randomUUID()
      const draftCommand = {
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: 1,
        operationId: draftOperationId,
        selectedMemberIds: [memberId],
        expectedManifestHash: candidate.manifestHash,
        expectedCandidateHash: candidate.candidateHash!,
        expectedPayloadHash: candidate.payloadHash!,
        partialAcknowledged: false,
      }
      const draft = await measured('create-draft-handoff', () =>
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: draftCommand,
        }),
      )
      const packageId = draft.value.id
      const replay = await createIntakeV1PackageDraftForAdmin({
        db,
        actorId: ownerUserId,
        command: draftCommand,
      })
      expect(replay.value).toMatchObject({ id: packageId, replayed: true })
      await expect(
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: { ...draftCommand, expectedCandidateHash: 'f'.repeat(64) },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: {
            ...draftCommand,
            tenantId: foreignTenantId,
            venueId: foreignVenueId,
            operationId: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|FORBIDDEN|CONFLICT/u) })
      await expect(
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: {
            ...draftCommand,
            operationId: randomUUID(),
            expectedManifestHash: 'e'.repeat(64),
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const review = await measured('review-preview', () =>
        db.$transaction((tx) =>
          loadReviewableVenuePackageEvaluationPreview(tx, tenantId, { venueId, packageId }),
        ),
      )
      expect(review.package).toMatchObject({ id: packageId, status: 'DRAFT' })

      const context = {
        db,
        headers: new Headers(),
        session: {
          userId: ownerUserId,
          activeTenantId: tenantId,
          role: 'OWNER' as const,
          isPlatformAdmin: true,
        },
      } as TRPCContext
      const evaluation = await measured('prepare-evaluation', () =>
        adminEvaluationOnboardingActionsRouter
          .createCaller(context)
          .prepareOnboardingEvaluationSuite({ tenantId, venueId, packageId, suite: 'CORE' }),
      )
      expect(evaluation.package).toMatchObject({ id: packageId, status: 'DRAFT' })
      expect(evaluation.cases.length).toBeGreaterThan(0)

      const journey = await measured('read-portal', () =>
        portalRouter.createCaller(context).getOnboardingJourney({ venueId }),
      )
      const billing = await measured('read-billing', () =>
        getTenantBillingOverview({ tenantId, client: db }),
      )
      const handoff = await db.intakeV1PackageHandoff.findFirstOrThrow({
        where: { tenantId, venueId, packageDraftId: packageId },
      })

      expect(handoff).toMatchObject({ revisionId: revision.id, packageDraftId: packageId })
      expect(journey).toMatchObject({
        venue: { id: venueId },
        release: { released: false, hasReviewedArtifact: false },
        publication: { clientCanPublish: false },
      })
      expect(await db.customerAccessRequest.count()).toBe(0)

      const accessIdentityId = `identity-v1-delivery-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: accessIdentityId,
          tenantId,
          venueId,
          identityKey: `customer-access-v1-delivery.${suffix}`,
          name: 'V1 delivery customer access worker',
          agentType: 'CUSTOMER_OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['customer-access:prepare'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: ownerUserId,
        },
      })
      const accessRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: accessIdentityId,
          runType: 'CUSTOMER_SUPPORT',
          requestedOperation: 'customer-access.invite-member',
          requestPrompt: 'Prepare the exact venue-scoped owner access request.',
          scopeSnapshot: { accessCapabilities: ['customer-access:prepare'] },
          status: 'RUNNING',
          startedAt: new Date(),
          initiatedByType: 'HUMAN',
          initiatedById: ownerUserId,
        },
      })
      const supportRequest = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'GENERAL',
          subject: 'Invite the interested venue contact',
          createdByKind: 'CLIENT',
          createdById: ownerUserId,
          requesterUserId: ownerUserId,
          updatedByKind: 'CLIENT',
          updatedById: ownerUserId,
        },
      })
      const sourceSupportMessage = await db.supportMessage.create({
        data: {
          tenantId,
          venueId,
          supportRequestId: supportRequest.id,
          authorKind: 'CLIENT',
          authorId: ownerUserId,
          visibility: 'CLIENT_VISIBLE',
          body: `Please invite ${prospectEmail} as a team member for this venue.`,
          clientVersion: 1,
        },
      })
      const accessOperationId = randomUUID()
      const preparedAccess = await prepareCustomerAccessRequestAction({
        operationId: accessOperationId,
        tenantId,
        venueId,
        supportRequestId: supportRequest.id,
        sourceSupportMessageId: sourceSupportMessage.id,
        emailAddress: prospectEmail,
        requestedRole: 'MEMBER',
        reason: 'Exact venue-scoped owner-authored invitation request.',
        actor: {
          type: 'AGENT',
          actorId: accessIdentityId,
          role: 'AGENT',
          agentIdentityId: accessIdentityId,
          agentRunId: accessRun.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'customer-access:prepare',
          idempotencyKey: accessOperationId,
        },
      })
      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: preparedAccess.request.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Synthetic human approval for the exact connected V1 access request.',
        actor: {
          actorType: 'HUMAN',
          actorId: ownerUserId,
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      const approvedAccess = await db.customerAccessRequest.findUniqueOrThrow({
        where: { id: preparedAccess.request.id },
        select: { status: true, updatedAt: true },
      })
      expect(approvedAccess.status).toBe('APPROVED')

      const invitationProviderId = `invite-v1-delivery-${suffix}`
      authMocks.ensureOrganizationInvitation.mockResolvedValue({
        id: invitationProviderId,
        replayed: false,
      })
      const adminCaller = appRouter.createCaller(context)
      const executionInput = {
        tenantId,
        venueId,
        requestId: preparedAccess.request.id,
        expectedUpdatedAt: approvedAccess.updatedAt,
      }
      await expect(
        adminCaller.admin.executeApprovedCustomerInvitation({
          ...executionInput,
          venueId: foreignVenueId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        adminCaller.admin.executeApprovedCustomerInvitation({
          ...executionInput,
          tenantId: foreignTenantId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const nonAdminCaller = appRouter.createCaller({
        ...context,
        session: { ...context.session, isPlatformAdmin: false },
      })
      await expect(
        nonAdminCaller.admin.executeApprovedCustomerInvitation(executionInput),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(authMocks.ensureOrganizationInvitation).not.toHaveBeenCalled()

      await expect(
        adminCaller.admin.executeApprovedCustomerInvitation(executionInput),
      ).resolves.toEqual({
        requestId: preparedAccess.request.id,
        status: 'INVITED',
        providerInvitationId: invitationProviderId,
        replayed: false,
        membershipCreatedLocally: false,
      })
      expect(authMocks.ensureOrganizationInvitation).toHaveBeenCalledTimes(1)
      expect(authMocks.ensureOrganizationInvitation).toHaveBeenCalledWith({
        organizationId: tenantId,
        emailAddress: prospectEmail,
        role: 'org:member',
        inviterUserId: ownerUserId,
      })
      const invitedAccess = await db.customerAccessRequest.findUniqueOrThrow({
        where: { id: preparedAccess.request.id },
        select: { status: true, providerInvitationId: true, updatedAt: true },
      })
      expect(invitedAccess).toMatchObject({
        status: 'INVITED',
        providerInvitationId: invitationProviderId,
      })
      await expect(
        adminCaller.admin.executeApprovedCustomerInvitation({
          ...executionInput,
          expectedUpdatedAt: invitedAccess.updatedAt,
        }),
      ).resolves.toEqual({
        requestId: preparedAccess.request.id,
        status: 'INVITED',
        providerInvitationId: invitationProviderId,
        replayed: true,
        membershipCreatedLocally: false,
      })
      expect(authMocks.ensureOrganizationInvitation).toHaveBeenCalledTimes(1)
      expect(
        await db.tenantMembership.count({
          where: { tenantId, user: { email: { equals: prospectEmail, mode: 'insensitive' } } },
        }),
      ).toBe(0)
      expect(
        await db.auditLog.findMany({
          where: {
            tenantId,
            targetType: 'CustomerAccessRequest',
            targetId: preparedAccess.request.id,
          },
          select: { action: true },
          orderBy: { createdAt: 'asc' },
        }),
      ).toEqual([
        { action: 'customer-access.invitation-prepared' },
        { action: 'customer-access.provider-started' },
        { action: 'customer-access.invitation-confirmed' },
      ])
      expect(
        await db.prospectOnboardingDeliveryAttempt.findUniqueOrThrow({
          where: { id: invitationDraft.id },
          select: { id: true, subject: true, textBody: true },
        }),
      ).toEqual({
        id: invitationDraft.id,
        subject: invitationDraft.subject,
        textBody: invitationDraft.textBody,
      })
      expect(
        await db.prospectLocationConversion.findMany({
          where: { relationshipId: conversion.relationship.id },
          select: { prospectVenueId: true, venueId: true, status: true },
        }),
      ).toEqual([{ prospectVenueId: prospectVenues[0]!.id, venueId, status: 'ACTIVE' }])
      expect(
        await db.prospectLocationConversion.count({
          where: { prospectVenueId: prospectVenues[1]!.id },
        }),
      ).toBe(0)
      expect(journey.preview.state).toBe('UNAVAILABLE')
      await expect(
        db.venue.findFirstOrThrow({
          where: { id: venueId, tenantId },
          select: { isActive: true },
        }),
      ).resolves.toEqual({ isActive: false })
      expect(billing.account).toBeNull()
      expect(await db.venuePackage.count({ where: { tenantId, venueId, status: 'APPLIED' } })).toBe(
        0,
      )
      expect(await db.prospectSendOutbox.count()).toBe(0)
      expect(await db.prospectEmailMessage.count({ where: { direction: 'OUTBOUND' } })).toBe(0)
      expect(await db.customerAccessRequest.count()).toBe(1)
      expect(operationCount).toBe(8)
      expect(Object.keys(operationDurationsMs).sort()).toEqual([
        'collect',
        'create-draft-handoff',
        'freeze-v1',
        'prepare-evaluation',
        'preview-candidate',
        'read-billing',
        'read-portal',
        'review-preview',
      ])
      expect(Object.values(operationDurationsMs).every((duration) => duration >= 0)).toBe(true)
      process.stdout.write(
        JSON.stringify({
          proof: 'intake-v1-connected-crm-held-delivery-preparation-v2',
          synthetic: true,
          operationCount,
          operationCountScope: 'timed customer delivery subset; CRM setup and review are excluded',
          operationDurationsMs,
          prospectOrganizationId: prospectOrganization.id,
          prospectVenueId: prospectVenues[0]!.id,
          onboardingDeliveryAttemptId: invitationDraft.id,
          prospectLocationConversionId: conversion.locationConversion!.id,
          customerAccessRequestId: preparedAccess.request.id,
          customerAccess: 'INVITED_PROVIDER_MOCK',
          providerInvitationCalls: authMocks.ensureOrganizationInvitation.mock.calls.length,
          lineageLimit:
            'Local seeded owner and mocked organization-invitation provider; no Clerk transport, account acceptance, or customer delivery.',
          publication: 'HELD',
          qrReadiness: 'HELD_UNTIL_ACTIVE',
          invitationDraft: 'RETAINED_PROVIDER_DARK',
          billingReadiness: billing.account === null ? 'NOT_CONFIGURED' : 'CONFIGURED',
        }) + '\n',
      )
    })
  })
})
