import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import { prepareSupportTriageProposalAction } from './support-triage-proposal-actions'

const enabled =
  process.env.RUN_SUPPORT_TRIAGE_PROPOSAL_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support triage proposal disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('preserves exact triage evidence while approval remains execution-free', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-support-triage-${suffix}`
      const venueId = `venue-support-triage-${suffix}`
      const identityId = `identity-support-triage-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support triage tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic support triage venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support-triage.${suffix}`,
          name: 'Support triage reviewer',
          agentType: 'SUPPORT',
          accessScope: 'VENUE',
          accessCapabilities: ['support:triage'],
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
          requestedOperation: 'support.triage.propose',
          scopeSnapshot: { accessCapabilities: ['support:triage'] },
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
          category: 'GENERAL',
          status: 'OPEN',
          subject: 'Admission information appears stale',
          missingInformation: [],
          createdByKind: 'OPERATOR',
          createdById: 'integration-operator',
          updatedByKind: 'OPERATOR',
          updatedById: 'integration-operator',
        },
      })
      const requestProjection = {
        category: true,
        status: true,
        missingInformation: true,
        version: true,
        clientVersion: true,
        clientActivityAt: true,
        statusChangedAt: true,
        updatedByKind: true,
        updatedById: true,
        updatedAt: true,
      } as const
      const before = await db.supportRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: requestProjection,
      })

      const operationId = randomUUID()
      const proposalInput = {
        operationId,
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        category: 'CONTENT_CORRECTION' as const,
        missingInformation: ['Current admission price', 'Effective date'],
        reason: 'The customer request lacks two facts required for a safe content correction.',
        evidence: [{ type: 'SupportRequest', id: request.id }],
        actor: {
          type: 'AGENT' as const,
          actorId: identityId,
          role: 'AGENT' as const,
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'support:triage',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: operationId,
        },
      }

      const prepared = await prepareSupportTriageProposalAction(proposalInput)
      expect(prepared).toMatchObject({
        replayed: false,
        approvalRequest: {
          id: operationId,
          proposedAction: 'torchiko.support.triage',
          scopeSnapshot: {
            requestId: request.id,
            expectedVersion: request.version,
            proposedCategory: 'CONTENT_CORRECTION',
            proposedMissingInformation: ['Current admission price', 'Effective date'],
            supportRequestChanged: false,
            clientActivityChanged: false,
            customerContacted: false,
            executionAuthorized: false,
          },
        },
      })
      await expect(prepareSupportTriageProposalAction(proposalInput)).resolves.toMatchObject({
        replayed: true,
        approvalRequest: { id: operationId },
      })

      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: operationId,
        decision: 'APPROVED',
        reason: 'The recommendation is approved for separate human application.',
        actor: {
          actorType: 'HUMAN',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })

      expect(
        await db.supportRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: requestProjection,
        }),
      ).toEqual(before)
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.supportRequestAuditEvent.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.agentAction.count({
          where: {
            tenantId,
            venueId,
            agentRunId: run.id,
            actionName: 'torchiko.support.propose_triage',
            status: 'SUCCEEDED',
          },
        }),
      ).toBe(1)
      expect(
        await db.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } }),
      ).toEqual({ status: 'AWAITING_APPROVAL' })

      await expect(
        prepareSupportTriageProposalAction({
          ...proposalInput,
          category: 'BRANDING',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })
})
