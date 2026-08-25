import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareSupportKnowledgeProposalAction } from './support-knowledge-proposal-actions'

const enabled =
  process.env.RUN_SUPPORT_KNOWLEDGE_PROPOSAL_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support knowledge proposal disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('freezes reviewed client evidence without changing support or canonical knowledge', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-support-knowledge-${suffix}`
      const venueId = `venue-support-knowledge-${suffix}`
      const operationId = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support knowledge tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic support knowledge venue', slug: venueId },
      })
      const request = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Accessible entrance details need correction',
          createdByKind: 'OPERATOR',
          createdById: 'integration-operator',
          updatedByKind: 'OPERATOR',
          updatedById: 'integration-operator',
        },
      })
      await db.supportRequestAuditEvent.create({
        data: {
          tenantId,
          venueId,
          supportRequestId: request.id,
          requestVersion: request.version,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: 'integration-operator',
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        },
      })
      const message = await db.supportMessage.create({
        data: {
          tenantId,
          venueId,
          supportRequestId: request.id,
          authorKind: 'CLIENT',
          authorId: 'client-reviewer',
          visibility: 'CLIENT_VISIBLE',
          body: 'The accessible entrance is on the east side, not the north side.',
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion: request.version,
          clientVersion: request.clientVersion,
        },
      })
      const beforeRequest = await db.supportRequest.findUniqueOrThrow({ where: { id: request.id } })

      const input = {
        operationId,
        tenantId,
        venueId,
        supportRequestId: request.id,
        expectedVersion: request.version,
        evidenceMessageIds: [message.id],
        correctionKind: 'UPDATE_KNOWLEDGE' as const,
        aiInference: 'The current entrance direction appears stale.',
        proposedChange: 'State that the accessible entrance is on the east side.',
        reason: 'The reviewed client message supplies the corrected direction.',
        confidence: 0.88,
        actor: {
          type: 'AGENT' as const,
          actorId: 'agent-support-knowledge',
          role: 'AGENT' as const,
          agentIdentityId: 'agent-support-knowledge',
          agentRunId: 'run-support-knowledge',
          workerId: 'worker-support-knowledge',
          credentialId: 'credential-support-knowledge',
          capability: 'knowledge:draft',
          idempotencyKey: operationId,
          modelProvider: 'provider-dark',
          modelName: 'deterministic-fixture',
        },
      }

      await expect(prepareSupportKnowledgeProposalAction(input)).resolves.toMatchObject({
        replayed: false,
        proposal: {
          id: operationId,
          status: 'PENDING_REVIEW',
          supportRequestId: request.id,
          supportRequestVersion: request.version,
        },
      })
      await expect(prepareSupportKnowledgeProposalAction(input)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(
        prepareSupportKnowledgeProposalAction({
          ...input,
          operationId: randomUUID(),
          actor: { ...input.actor, idempotencyKey: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

      const secondOperationId = randomUUID()
      await expect(
        prepareSupportKnowledgeProposalAction({
          ...input,
          operationId: secondOperationId,
          actor: { ...input.actor, idempotencyKey: secondOperationId },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const [proposal, afterRequest, canonicalCount, audit] = await Promise.all([
        db.knowledgeChangeProposal.findUniqueOrThrow({ where: { id: operationId } }),
        db.supportRequest.findUniqueOrThrow({ where: { id: request.id } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        db.auditLog.findFirstOrThrow({
          where: {
            tenantId,
            action: 'knowledge-proposal.created-from-support',
            targetId: operationId,
          },
        }),
      ])
      expect(proposal).toMatchObject({
        supportRequestId: request.id,
        supportRequestVersion: request.version,
        evidenceMessageIds: [message.id],
        status: 'PENDING_REVIEW',
        createdByType: 'AGENT',
      })
      expect(afterRequest).toEqual(beforeRequest)
      expect(canonicalCount).toBe(0)
      expect(audit).toMatchObject({
        agentRunId: 'run-support-knowledge',
        credentialId: 'credential-support-knowledge',
        capability: 'knowledge:draft',
      })

      await expect(
        db.knowledgeChangeProposal.update({
          where: { id: operationId },
          data: { proposedChange: '[UPDATE_KNOWLEDGE]\nTampered content' },
        }),
      ).rejects.toThrow(/source evidence is immutable/u)
      await expect(
        db.knowledgeChangeProposal.update({
          where: { id: operationId },
          data: {
            status: 'APPROVED',
            reviewerId: 'integration-reviewer',
            reviewedAt: new Date(),
            reviewNote: 'Evidence verified; publication remains separate.',
          },
        }),
      ).resolves.toMatchObject({ status: 'APPROVED' })
      expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(0)
    })
  })
})
