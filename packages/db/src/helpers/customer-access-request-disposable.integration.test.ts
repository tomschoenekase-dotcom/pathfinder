import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import { prepareCustomerAccessRequestAction } from './customer-access-request-actions'

const enabled =
  process.env.RUN_CUSTOMER_ACCESS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('customer access request disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('prepares, replays, and approves exact owner-authored evidence without sending an invitation', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-access-${suffix}`
      const venueId = `venue-access-${suffix}`
      const ownerId = `owner-access-${suffix}`
      const identityId = `identity-access-${suffix}`
      const operationId = randomUUID()
      const targetEmail = `new-member-${suffix}@example.test`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic access tenant', slug: tenantId },
      })
      await db.user.create({
        data: { id: ownerId, email: `${ownerId}@example.test`, fullName: 'Synthetic Owner' },
      })
      await db.tenantMembership.create({
        data: {
          tenantId,
          userId: ownerId,
          role: 'OWNER',
          status: 'ACTIVE',
          joinedAt: new Date(),
        },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic access venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `customer-access.${suffix}`,
          name: 'Customer access worker',
          agentType: 'CUSTOMER_OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['customer-access:prepare'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: 'integration-operator',
        },
      })
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'CUSTOMER_SUPPORT',
          requestedOperation: 'customer-access.invite-member',
          requestPrompt: 'Prepare an owner-requested teammate invitation for review.',
          scopeSnapshot: { accessCapabilities: ['customer-access:prepare'] },
          status: 'RUNNING',
          startedAt: new Date(),
          initiatedByType: 'HUMAN',
          initiatedById: 'integration-operator',
        },
      })
      const supportRequest = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'GENERAL',
          subject: 'Add a teammate',
          createdByKind: 'CLIENT',
          createdById: ownerId,
          requesterUserId: ownerId,
          updatedByKind: 'CLIENT',
          updatedById: ownerId,
        },
      })
      const sourceMessage = await db.supportMessage.create({
        data: {
          tenantId,
          venueId,
          supportRequestId: supportRequest.id,
          authorKind: 'CLIENT',
          authorId: ownerId,
          visibility: 'CLIENT_VISIBLE',
          body: `Please invite ${targetEmail} as a team member.`,
          clientVersion: 1,
        },
      })
      const actor = {
        type: 'AGENT' as const,
        actorId: identityId,
        role: 'AGENT' as const,
        agentIdentityId: identityId,
        agentRunId: run.id,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        capability: 'customer-access:prepare',
        modelProvider: 'deterministic',
        modelName: 'fixture',
        idempotencyKey: operationId,
      }
      const actionInput = {
        operationId,
        tenantId,
        venueId,
        supportRequestId: supportRequest.id,
        sourceSupportMessageId: sourceMessage.id,
        emailAddress: targetEmail.toUpperCase(),
        requestedRole: 'MEMBER' as const,
        reason: 'The active organization owner requested this teammate invitation.',
        actor,
      }

      const prepared = await prepareCustomerAccessRequestAction(actionInput)
      expect(prepared.replayed).toBe(false)
      expect(prepared.request).toMatchObject({
        tenantId,
        venueId,
        targetEmail,
        requestedRole: 'MEMBER',
        status: 'AWAITING_APPROVAL',
        providerInvitationId: null,
      })
      await expect(prepareCustomerAccessRequestAction(actionInput)).resolves.toMatchObject({
        request: { id: prepared.request.id },
        replayed: true,
      })

      expect(
        await Promise.all([
          db.approvalRequest.count({
            where: { id: prepared.request.approvalRequestId, tenantId, venueId },
          }),
          db.agentAction.count({
            where: {
              tenantId,
              venueId,
              agentRunId: run.id,
              actionName: 'torchiko.customer_access.prepare_invitation',
              status: 'SUCCEEDED',
            },
          }),
          db.agentTimelineEvent.count({
            where: { tenantId, venueId, agentRunId: run.id },
          }),
          db.auditLog.count({
            where: {
              tenantId,
              agentRunId: run.id,
              action: 'customer-access.invitation-prepared',
            },
          }),
          db.tenantMembership.count({
            where: { tenantId, user: { email: { equals: targetEmail, mode: 'insensitive' } } },
          }),
        ]),
      ).toEqual([1, 1, 1, 1, 0])
      expect(
        await db.agentRun.findUnique({ where: { id: run.id }, select: { status: true } }),
      ).toEqual({ status: 'AWAITING_APPROVAL' })

      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: prepared.request.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Synthetic exact request approved for lifecycle proof only.',
        actor: {
          actorType: 'HUMAN',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })

      expect(
        await db.customerAccessRequest.findUnique({
          where: { id: prepared.request.id },
          select: { status: true, providerInvitationId: true },
        }),
      ).toEqual({ status: 'APPROVED', providerInvitationId: null })
      expect(
        await db.tenantMembership.count({
          where: { tenantId, user: { email: { equals: targetEmail, mode: 'insensitive' } } },
        }),
      ).toBe(0)
      await expect(
        db.customerAccessRequest.updateMany({
          where: { id: prepared.request.id, tenantId, status: 'APPROVED' },
          data: { targetEmail: `tampered-${targetEmail}` },
        }),
      ).rejects.toThrow(/evidence is immutable/u)
      await expect(
        db.customerAccessRequest.updateMany({
          where: { id: prepared.request.id, tenantId, status: 'APPROVED' },
          data: { status: 'INVITED' },
        }),
      ).rejects.toThrow(/invalid customer access request lifecycle transition/u)
    })
  })
})
