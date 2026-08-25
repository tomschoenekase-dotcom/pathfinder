import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  confirmCustomerInvitationAction,
  db,
  markCustomerInvitationReconciliationAction,
  prepareCustomerAccessRequestAction,
  recordApprovalDecisionAction,
  startApprovedCustomerInvitationAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { executeApprovedCustomerInvitation } from './lib/customer-access-executor'

const enabled =
  process.env.RUN_CUSTOMER_ACCESS_EXECUTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('approved customer access execution disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('executes exact approval and recovers an ambiguous provider outcome without local membership', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-access-exec-${suffix}`
      const venueId = `venue-access-exec-${suffix}`
      const ownerId = `owner-access-exec-${suffix}`
      const identityId = `identity-access-exec-${suffix}`
      const targetEmail = `new-member-${suffix}@example.test`

      await db.tenant.create({ data: { id: tenantId, name: 'Execution tenant', slug: tenantId } })
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
        data: { id: venueId, tenantId, name: 'Execution venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `customer-access-exec.${suffix}`,
          name: 'Customer access execution worker',
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
          requestPrompt: 'Prepare exact owner-requested access.',
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
      const operationId = randomUUID()
      const prepared = await prepareCustomerAccessRequestAction({
        operationId,
        tenantId,
        venueId,
        supportRequestId: supportRequest.id,
        sourceSupportMessageId: sourceMessage.id,
        emailAddress: targetEmail,
        requestedRole: 'MEMBER',
        reason: 'Exact owner-authored invitation request.',
        actor: {
          type: 'AGENT',
          actorId: identityId,
          role: 'AGENT',
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'customer-access:prepare',
          idempotencyKey: operationId,
        },
      })
      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: prepared.request.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Synthetic approval for provider-dark execution proof.',
        actor: {
          actorType: 'HUMAN',
          actorId: ownerId,
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      const approved = await db.customerAccessRequest.findUniqueOrThrow({
        where: { id: prepared.request.id },
        select: { updatedAt: true },
      })

      const provider = {
        ensure: vi
          .fn()
          .mockRejectedValueOnce(new Error('synthetic ambiguous provider outcome'))
          .mockResolvedValueOnce({ id: `invite-${suffix}`, replayed: true }),
      }
      const actor = { type: 'HUMAN', id: ownerId, role: 'PLATFORM_ADMIN' } as const
      await expect(
        executeApprovedCustomerInvitation(
          {
            tenantId,
            venueId,
            requestId: prepared.request.id,
            expectedUpdatedAt: approved.updatedAt,
            actor,
          },
          {
            provider,
            actions: {
              start: startApprovedCustomerInvitationAction,
              confirm: confirmCustomerInvitationAction,
              markReconciliation: markCustomerInvitationReconciliationAction,
            },
          },
        ),
      ).rejects.toThrow('synthetic ambiguous provider outcome')

      const reconciliation = await db.customerAccessRequest.findUniqueOrThrow({
        where: { id: prepared.request.id },
        select: { status: true, updatedAt: true, providerInvitationId: true },
      })
      expect(reconciliation).toMatchObject({
        status: 'RECONCILIATION_REQUIRED',
        providerInvitationId: null,
      })

      await expect(
        executeApprovedCustomerInvitation(
          {
            tenantId,
            venueId,
            requestId: prepared.request.id,
            expectedUpdatedAt: reconciliation.updatedAt,
            actor,
          },
          {
            provider,
            actions: {
              start: startApprovedCustomerInvitationAction,
              confirm: confirmCustomerInvitationAction,
              markReconciliation: markCustomerInvitationReconciliationAction,
            },
          },
        ),
      ).resolves.toMatchObject({
        status: 'INVITED',
        providerInvitationId: `invite-${suffix}`,
        replayed: true,
        membershipCreatedLocally: false,
      })

      expect(provider.ensure).toHaveBeenCalledTimes(2)
      expect(
        await db.customerAccessRequest.findUnique({
          where: { id: prepared.request.id },
          select: { status: true, providerInvitationId: true },
        }),
      ).toEqual({ status: 'INVITED', providerInvitationId: `invite-${suffix}` })
      expect(
        await db.tenantMembership.count({
          where: { tenantId, user: { email: { equals: targetEmail, mode: 'insensitive' } } },
        }),
      ).toBe(0)
      expect(
        await db.auditLog.count({
          where: {
            tenantId,
            targetType: 'CustomerAccessRequest',
            targetId: prepared.request.id,
            action: {
              in: [
                'customer-access.provider-started',
                'customer-access.reconciliation-required',
                'customer-access.invitation-confirmed',
              ],
            },
          },
        }),
      ).toBe(4)
      expect(
        await db.operationalEvent.findUnique({
          where: {
            tenantId_deduplicationKey: {
              tenantId,
              deduplicationKey: `customer-access-reconciliation:${prepared.request.id}`,
            },
          },
          select: { state: true, actionRequired: true },
        }),
      ).toEqual({ state: 'RESOLVED', actionRequired: true })
    })
  })
})
