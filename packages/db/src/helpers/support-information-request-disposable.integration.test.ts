import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import { consumeApprovalGrantAction, issueApprovalGrantAction } from './approval-grants'
import { requestSupportInformationAction } from './support-actions'
import { prepareSupportInformationRequestProposalAction } from './support-information-request-proposal-actions'

const enabled =
  process.env.RUN_SUPPORT_INFORMATION_REQUEST_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support information-request disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('applies exactly one reviewed in-app prompt with no external or adjacent effects', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-support-info-${suffix}`
      const venueId = `venue-support-info-${suffix}`
      const identityId = `identity-support-info-${suffix}`
      const checklist = ['Current admission price', 'Effective date']
      const body = 'Please provide the current admission price and its effective date.'

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support information tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic support information venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support-information.${suffix}`,
          name: 'Support information reviewer',
          agentType: 'SUPPORT',
          accessScope: 'VENUE',
          accessCapabilities: ['support:request-information'],
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
          requestedOperation: 'support.information-request.propose',
          scopeSnapshot: { accessCapabilities: ['support:request-information'] },
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
          subject: 'Admission information appears stale',
          missingInformation: checklist,
          createdByKind: 'OPERATOR',
          createdById: 'integration-operator',
          updatedByKind: 'OPERATOR',
          updatedById: 'integration-operator',
        },
      })

      const proposalOperationId = randomUUID()
      const proposal = await prepareSupportInformationRequestProposalAction({
        operationId: proposalOperationId,
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW',
        body,
        missingInformation: checklist,
        reason: 'The reviewed support evidence lacks both required current facts.',
        evidence: [{ type: 'SupportRequest', id: request.id }],
        actor: {
          type: 'AGENT',
          actorId: identityId,
          role: 'AGENT',
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'support:request-information',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: proposalOperationId,
        },
      })
      expect(proposal).toMatchObject({
        replayed: false,
        approvalRequest: {
          proposedAction: 'pathfinder.apply_support_information_request',
          scopeSnapshot: {
            requestId: request.id,
            expectedVersion: request.version,
            fromStatus: 'IN_REVIEW',
            toStatus: 'WAITING_FOR_CLIENT',
            body,
            missingInformation: checklist,
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
        reason: 'The exact prompt and unchanged checklist are approved for one in-app use.',
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
        toStatus: 'WAITING_FOR_CLIENT' as const,
        body,
        missingInformation: checklist,
      }
      const grant = await issueApprovalGrantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        actionName: 'pathfinder.apply_support_information_request',
        capability: 'support:request-information',
        mode: 'ONE_SHOT',
        scope: {
          contractVersion: 1,
          tenantId,
          venueId,
          approvalRequestId: proposalOperationId,
          effect: 'EXACT_CLIENT_INFORMATION_REQUEST_ONLY',
        },
        parameters,
        approvalDecisionId: decision.id,
        issueReason: 'Apply this exact reviewed synthetic in-app prompt once.',
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
        capability: 'support:request-information',
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
              actionName: 'pathfinder.apply_support_information_request',
              capability: 'support:request-information',
              parameters,
              actor,
            },
            sameTransaction,
          )
          const result = await requestSupportInformationAction(
            {
              operationId,
              tenantId,
              venueId,
              requestId: request.id,
              expectedVersion: request.version,
              body,
              missingInformation: checklist,
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
                capability: 'support:request-information',
                modelProvider: 'deterministic',
                modelName: 'fixture',
                idempotencyKey: operationId,
              },
            },
            sameTransaction,
          )
          const reference = `SupportMessage:${result.message.id}:SupportRequest:${request.id}:v${result.requestVersion}:WAITING_FOR_CLIENT`
          if (consumption.replayed) expect(consumption.consumption.resultReference).toBe(reference)
          else
            await tx.approvalGrantConsumption.update({
              where: { id: consumption.consumption.id },
              data: { resultReference: reference },
            })
          return result
        })

      await expect(apply()).resolves.toMatchObject({
        status: 'WAITING_FOR_CLIENT',
        missingInformation: checklist,
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
          actionName: 'pathfinder.apply_support_information_request',
          capability: 'support:request-information',
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
        status: 'WAITING_FOR_CLIENT',
        category: 'CONTENT_CORRECTION',
        missingInformation: checklist,
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
