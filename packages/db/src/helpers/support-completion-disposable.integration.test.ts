import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import { consumeApprovalGrantAction, issueApprovalGrantAction } from './approval-grants'
import { completeSupportRequestAction } from './support-actions'
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
      const body = 'Your requested venue update is complete and ready to use.'

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support completion tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic support completion venue', slug: venueId },
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
          createdByKind: 'OPERATOR',
          createdById: 'integration-operator',
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
            requestId: request.id,
            expectedVersion: request.version,
            fromStatus: 'IN_REVIEW',
            toStatus: 'COMPLETED',
            body,
            missingInformationCount: 0,
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
      const parameters = {
        clientId: tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW' as const,
        toStatus: 'COMPLETED' as const,
        body,
      }
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
          const reference = `SupportMessage:${result.message.id}:SupportRequest:${request.id}:v${result.requestVersion}:COMPLETED`
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
    })
  })
})
