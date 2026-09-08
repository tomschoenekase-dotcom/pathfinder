import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { SupportCompletionApplyParameters } from '@pathfinder/contracts'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import { consumeApprovalGrantAction, issueApprovalGrantAction } from './approval-grants'
import { appendSupportMessageAction, completeSupportRequestAction } from './support-actions'
import { prepareSupportCompletionProposalAction } from './support-completion-proposal-actions'

const enabled =
  process.env.RUN_SUPPORT_COMPLETION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support completion disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('applies exactly one reviewed in-app completion with no external or adjacent effects', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-support-complete-${suffix}`
      const venueId = `venue-support-complete-${suffix}`
      const identityId = `identity-support-complete-${suffix}`
      const clientId = `client-support-complete-${suffix}`
      const body = 'Your requested venue update is complete and ready to use.'

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support completion tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic support completion venue', slug: venueId },
      })
      await db.user.create({
        data: { id: clientId, email: `${clientId}@example.test`, fullName: 'Synthetic client' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: clientId, role: 'STAFF', status: 'ACTIVE' },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support-completion.${suffix}`,
          name: 'Support completion reviewer',
          agentType: 'SUPPORT',
          accessScope: 'VENUE',
          accessCapabilities: ['support:complete'],
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
          runType: 'SUPPORT',
          requestedOperation: 'support.completion.propose',
          scopeSnapshot: { accessCapabilities: ['support:complete'] },
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: 'integration-operator',
          startedAt: new Date(),
        },
      })
      const request = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Requested venue information update',
          missingInformation: [],
          createdByKind: 'CLIENT',
          createdById: clientId,
          requesterUserId: clientId,
          updatedByKind: 'OPERATOR',
          updatedById: 'integration-operator',
        },
      })

      const proposalOperationId = randomUUID()
      const proposal = await prepareSupportCompletionProposalAction({
        operationId: proposalOperationId,
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW',
        body,
        reason: 'The reviewed work is complete and no requested information remains unresolved.',
        evidence: [{ type: 'SupportRequest', id: request.id }],
        actor: {
          type: 'AGENT',
          actorId: identityId,
          role: 'AGENT',
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'support:complete',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: proposalOperationId,
        },
      })
      expect(proposal).toMatchObject({
        replayed: false,
        approvalRequest: {
          proposedAction: 'pathfinder.apply_support_completion',
          scopeSnapshot: {
            contractVersion: 2,
            requestId: request.id,
            expectedVersion: request.version,
            fromStatus: 'IN_REVIEW',
            toStatus: 'COMPLETED',
            body,
            missingInformationCount: 0,
            packageFulfillment: {
              linkedPackageCount: 0,
              packages: [],
            },
            allLinkedPackagesApplied: true,
            clientVisibleMessageCreated: false,
            customerContacted: false,
            externalDeliveryTriggered: false,
          },
        },
      })
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(0)

      const decision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: proposalOperationId,
        decision: 'APPROVED',
        reason: 'The exact completion message and unchanged request version are approved once.',
        actor: {
          actorType: 'HUMAN',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      const parameters = SupportCompletionApplyParameters.parse({
        clientId: tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW' as const,
        toStatus: 'COMPLETED' as const,
        body,
        packageFulfillment: (
          proposal.approvalRequest.scopeSnapshot as { packageFulfillment: unknown }
        ).packageFulfillment,
      })
      const grant = await issueApprovalGrantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        actionName: 'pathfinder.apply_support_completion',
        capability: 'support:complete',
        mode: 'ONE_SHOT',
        scope: {
          contractVersion: 1,
          tenantId,
          venueId,
          approvalRequestId: proposalOperationId,
          effect: 'EXACT_CLIENT_COMPLETION_ONLY',
        },
        parameters,
        approvalDecisionId: decision.id,
        issueReason: 'Apply this exact reviewed synthetic in-app completion once.',
        actor: { type: 'HUMAN', id: 'integration-operator', role: 'PLATFORM_ADMIN' },
      })
      const operationId = randomUUID()
      const actor = {
        type: 'AGENT' as const,
        role: 'AGENT' as const,
        actorId: identityId,
        agentIdentityId: identityId,
        agentRunId: run.id,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        approvalGrantId: grant.id,
        capability: 'support:complete',
        modelProvider: 'deterministic',
        modelName: 'fixture',
        idempotencyKey: operationId,
      }
      const apply = () =>
        db.$transaction(async (tx) => {
          const sameTransaction = {
            $transaction: async (callback: (inner: typeof tx) => unknown) => callback(tx),
          } as never
          const consumption = await consumeApprovalGrantAction(
            {
              tenantId,
              venueId,
              approvalGrantId: grant.id,
              operationId,
              actionName: 'pathfinder.apply_support_completion',
              capability: 'support:complete',
              parameters,
              actor,
            },
            sameTransaction,
          )
          const result = await completeSupportRequestAction(
            {
              operationId,
              tenantId,
              venueId,
              requestId: request.id,
              expectedVersion: request.version,
              body,
              packageFulfillment: parameters.packageFulfillment,
              actor: {
                actorType: 'AGENT',
                participantKind: 'AGENT',
                actorId: identityId,
                auditRole: 'AGENT',
                agentIdentityId: identityId,
                agentRunId: run.id,
                workerId: actor.workerId,
                credentialId: actor.credentialId,
                approvalGrantId: grant.id,
                capability: 'support:complete',
                modelProvider: 'deterministic',
                modelName: 'fixture',
                idempotencyKey: operationId,
              },
            },
            sameTransaction,
          )
          const reference = `SupportMessage:${result.message.id}:SupportRequest:${request.id}:v${result.operationVersion.requestVersion}:COMPLETED`
          if (consumption.replayed) expect(consumption.consumption.resultReference).toBe(reference)
          else
            await tx.approvalGrantConsumption.update({
              where: { id: consumption.consumption.id },
              data: { resultReference: reference },
            })
          return result
        })

      await expect(apply()).resolves.toMatchObject({
        status: 'COMPLETED',
        missingInformation: [],
        requestVersion: request.version + 1,
        clientVersion: request.clientVersion + 1,
        currentProjection: {
          requestVersion: request.version + 1,
          clientVersion: request.clientVersion + 1,
          status: 'COMPLETED',
        },
        operationVersion: {
          requestVersion: request.version + 1,
          clientVersion: request.clientVersion + 1,
        },
        replayed: false,
      })
      await expect(apply()).resolves.toMatchObject({ replayed: true })
      await expect(
        consumeApprovalGrantAction({
          tenantId,
          venueId,
          approvalGrantId: grant.id,
          operationId,
          actionName: 'pathfinder.apply_support_completion',
          capability: 'support:complete',
          parameters: { ...parameters, body: `${body} Changed.` },
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.supportRequestParticipant.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.supportRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, category: true, missingInformation: true },
        }),
      ).toEqual({
        status: 'COMPLETED',
        category: 'CONTENT_CORRECTION',
        missingInformation: [],
      })
      expect(
        await db.approvalGrant.findUniqueOrThrow({
          where: { id: grant.id },
          select: { mode: true, useCount: true, maxUses: true },
        }),
      ).toEqual({ mode: 'ONE_SHOT', useCount: 1, maxUses: 1 })

      const followup = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: request.id,
        expectedClientVersion: request.clientVersion + 1,
        visibility: 'CLIENT_VISIBLE' as const,
        body: 'The update helped, but the entrance hours still need correction.',
        attachments: [],
        actor: {
          actorType: 'HUMAN' as const,
          participantKind: 'CLIENT' as const,
          actorId: clientId,
          auditRole: 'STAFF' as const,
        },
      }
      await expect(
        appendSupportMessageAction({
          ...followup,
          actor: { ...followup.actor, actorId: `unrelated-${suffix}` },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const replies = await Promise.all([
        appendSupportMessageAction(followup),
        appendSupportMessageAction(followup),
      ])
      expect(replies.map((reply) => reply.replayed).sort()).toEqual([false, true])
      expect(new Set(replies.map((reply) => reply.message.id)).size).toBe(1)
      expect(replies.every((reply) => reply.status === 'IN_REVIEW')).toBe(true)
      expect(
        await db.supportRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({
        status: 'IN_REVIEW',
        version: request.version + 2,
        clientVersion: request.clientVersion + 2,
      })
      expect(await db.supportRequest.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(2)
      expect(
        await db.supportRequestAuditEvent.count({
          where: {
            tenantId,
            supportRequestId: request.id,
            fromStatus: 'COMPLETED',
            toStatus: 'IN_REVIEW',
          },
        }),
      ).toBe(1)
      const beforeCompletionReplay = await Promise.all([
        db.supportRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true, missingInformation: true, version: true, clientVersion: true },
        }),
        db.supportMessage.count({ where: { tenantId, venueId } }),
        db.supportRequestAuditEvent.count({
          where: { tenantId, venueId, supportRequestId: request.id },
        }),
        db.venuePackage.count({ where: { tenantId, venueId } }),
        db.approvalGrant.findUniqueOrThrow({
          where: { id: grant.id },
          select: { useCount: true },
        }),
      ])
      const completionReplay = await apply()
      expect(completionReplay).toMatchObject({
        replayed: true,
        status: 'IN_REVIEW',
        missingInformation: [],
        requestVersion: request.version + 2,
        clientVersion: request.clientVersion + 2,
        currentProjection: {
          requestVersion: request.version + 2,
          clientVersion: request.clientVersion + 2,
          status: 'IN_REVIEW',
        },
        operationVersion: {
          requestVersion: request.version + 1,
          clientVersion: request.clientVersion + 1,
        },
      })
      await expect(
        Promise.all([
          db.supportRequest.findUniqueOrThrow({
            where: { id: request.id },
            select: { status: true, missingInformation: true, version: true, clientVersion: true },
          }),
          db.supportMessage.count({ where: { tenantId, venueId } }),
          db.supportRequestAuditEvent.count({
            where: { tenantId, venueId, supportRequestId: request.id },
          }),
          db.venuePackage.count({ where: { tenantId, venueId } }),
          db.approvalGrant.findUniqueOrThrow({
            where: { id: grant.id },
            select: { useCount: true },
          }),
        ]),
      ).resolves.toEqual(beforeCompletionReplay)
      const internalNote = await appendSupportMessageAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version + 2,
        visibility: 'INTERNAL_ONLY',
        body: 'Private diagnostic detail for the reopened request.',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'OPERATOR',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      expect(internalNote).toMatchObject({
        replayed: false,
        status: 'IN_REVIEW',
        requestVersion: request.version + 3,
        clientVersion: request.clientVersion + 2,
        currentProjection: {
          requestVersion: request.version + 3,
          clientVersion: request.clientVersion + 2,
          status: 'IN_REVIEW',
        },
        operationVersion: {
          requestVersion: request.version + 3,
          clientVersion: null,
        },
      })
      const lateReplay = await appendSupportMessageAction(followup)
      expect(lateReplay).toMatchObject({
        replayed: true,
        message: { id: replies[0]!.message.id },
        status: 'IN_REVIEW',
        requestVersion: request.version + 3,
        clientVersion: request.clientVersion + 2,
        currentProjection: {
          requestVersion: request.version + 3,
          clientVersion: request.clientVersion + 2,
          status: 'IN_REVIEW',
        },
        operationVersion: {
          requestVersion: request.version + 2,
          clientVersion: request.clientVersion + 2,
        },
      })
      expect(
        await db.supportMessage.findMany({
          where: { tenantId, venueId, supportRequestId: request.id, visibility: 'CLIENT_VISIBLE' },
          select: { body: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ).toEqual([{ body }, { body: followup.body }])
      expect(
        await db.supportMessage.findMany({
          where: { tenantId, venueId, supportRequestId: request.id, visibility: 'INTERNAL_ONLY' },
          select: { body: true },
        }),
      ).toEqual([{ body: 'Private diagnostic detail for the reopened request.' }])
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(3)
      await expect(
        appendSupportMessageAction({ ...followup, operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })
})
