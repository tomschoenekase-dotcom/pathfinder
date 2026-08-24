import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: {
    PLACE_CONTENT: 'place-content',
    KNOWLEDGE_CONTENT: 'knowledge-content',
  },
  AiGatewayError: class AiGatewayError extends Error {
    code = 'provider-error'
  },
  getAiEmbeddingProfile: (key: string) => `integration-profile:${key}`,
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
}))

import {
  consumeApprovalGrantAction,
  db,
  issueApprovalGrantAction,
  prepareSupportPackageDraftProposalAction,
  recordApprovalDecisionAction,
  supportPackageDraftPayloadHash,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { supportAgentReviewedDraftFinalizer } from './lib/admin-reviewed-draft-finalizers'
import { VenuePackageDraftInput } from './schemas/venue-package'
import { createVenuePackageDraftService } from './routers/venue-package'

const enabled =
  process.env.RUN_SUPPORT_PACKAGE_DRAFT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_package_draft_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support package-draft disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('creates and links one exact approved V3 DRAFT with atomic one-shot lineage', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-support-package-${suffix}`
      const identityId = `identity-support-package-${suffix}`
      const operatorId = 'integration-operator'
      const draftKey = randomUUID()
      const payload = {
        schemaVersion: 3 as const,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: {
          create: [
            {
              itemKey: randomUUID(),
              provenance: {
                sourceType: 'SUPPORT_REQUEST',
                sourceName: 'Reviewed support request',
                contentOrigin: 'HUMAN_AUTHORED' as const,
              },
              value: {
                title: 'Visitor guidance',
                category: 'Visitor information',
                content: 'The reviewed visitor guidance is current.',
                isEnabled: true,
              },
            },
          ],
          update: [],
          delete: [],
        },
      }
      const operationCounts = {
        venuePatch: false,
        placeCreates: 0,
        placeUpdates: 0,
        placeDeletes: 0,
        knowledgeCreates: 1,
        knowledgeUpdates: 0,
        knowledgeDeletes: 0,
        total: 1,
      }

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic support package tenant', slug: tenantId },
      })
      const venue = await db.venue.create({
        data: {
          tenantId,
          name: 'Synthetic support package venue',
          slug: `venue-support-package-${suffix}`,
        },
      })
      const venueId = venue.id
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support-package.${suffix}`,
          name: 'Support package author',
          agentType: 'SUPPORT',
          accessScope: 'VENUE',
          accessCapabilities: ['packages:draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: operatorId,
        },
      })
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'SUPPORT',
          requestedOperation: 'support.package-draft.propose',
          scopeSnapshot: { accessCapabilities: ['packages:draft'] },
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: operatorId,
          startedAt: new Date(),
        },
      })
      const request = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Update reviewed visitor guidance',
          missingInformation: [],
          createdByKind: 'OPERATOR',
          createdById: operatorId,
          updatedByKind: 'OPERATOR',
          updatedById: operatorId,
        },
      })

      const proposalOperationId = randomUUID()
      const proposal = await prepareSupportPackageDraftProposalAction({
        operationId: proposalOperationId,
        tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW',
        draftKey,
        payload,
        operationCounts,
        reason: 'The exact reviewed support change is ready for one immutable package draft.',
        evidence: [{ type: 'SupportRequest', id: request.id }],
        actor: {
          type: 'AGENT',
          actorId: identityId,
          role: 'AGENT',
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'packages:draft',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: proposalOperationId,
        },
      })
      expect(proposal).toMatchObject({ replayed: false })
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.supportPackageHandoff.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.supportRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { version: true, clientVersion: true, status: true },
        }),
      ).toEqual({
        version: request.version,
        clientVersion: request.clientVersion,
        status: 'IN_REVIEW',
      })

      const decision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: proposalOperationId,
        decision: 'APPROVED',
        reason: 'Approve one exact DRAFT and support-request link; no package application.',
        actor: { actorType: 'HUMAN', actorId: operatorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const parameters = {
        clientId: tenantId,
        venueId,
        requestId: request.id,
        expectedVersion: request.version,
        fromStatus: 'IN_REVIEW' as const,
        draftKey,
        payload,
        proposalPayloadHash: supportPackageDraftPayloadHash(payload),
        operationCounts,
      }
      const grant = await issueApprovalGrantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        actionName: 'pathfinder.apply_support_package_draft',
        capability: 'packages:draft',
        mode: 'ONE_SHOT',
        scope: {
          contractVersion: 1,
          tenantId,
          venueId,
          approvalRequestId: proposalOperationId,
          effect: 'EXACT_SUPPORT_LINKED_V3_DRAFT_ONLY',
        },
        parameters,
        approvalDecisionId: decision.id,
        issueReason: 'Apply this exact reviewed synthetic package draft once.',
        actor: { type: 'HUMAN', id: operatorId, role: 'PLATFORM_ADMIN' },
      })
      const applyOperationId = randomUUID()
      const actor = {
        type: 'AGENT' as const,
        actorId: identityId,
        role: 'AGENT' as const,
        agentIdentityId: identityId,
        agentRunId: run.id,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        approvalGrantId: grant.id,
        capability: 'packages:draft',
        modelProvider: 'deterministic',
        modelName: 'fixture',
        idempotencyKey: applyOperationId,
      }
      const apply = () =>
        createVenuePackageDraftService({
          db,
          tenantId,
          actor,
          input: VenuePackageDraftInput.parse({ venueId, draftKey, payload }),
          finalizer: supportAgentReviewedDraftFinalizer({
            actor,
            operationId: applyOperationId,
            supportRequestId: request.id,
            expectedVersion: request.version,
            fromStatus: 'IN_REVIEW',
            draftKey,
            payload,
            proposalPayloadHash: parameters.proposalPayloadHash,
            operationCounts,
          }),
        })

      const applied = await apply()
      expect(applied.value).toMatchObject({
        status: 'DRAFT',
        createdBy: identityId,
        replayed: false,
      })
      expect(applied.attachment).toMatchObject({
        requestVersion: request.version + 1,
        replayed: false,
      })
      const replay = await apply()
      expect(replay.value).toMatchObject({ id: applied.value.id, status: 'DRAFT', replayed: true })
      expect(replay.attachment).toMatchObject({ replayed: true })
      await expect(
        consumeApprovalGrantAction({
          tenantId,
          venueId,
          approvalGrantId: grant.id,
          operationId: applyOperationId,
          actionName: 'pathfinder.apply_support_package_draft',
          capability: 'packages:draft',
          parameters: { ...parameters, expectedVersion: request.version + 1 },
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.supportPackageHandoff.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.supportRequestParticipant.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.supportRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { version: true, clientVersion: true, status: true, category: true },
        }),
      ).toEqual({
        version: request.version + 1,
        clientVersion: request.clientVersion,
        status: 'IN_REVIEW',
        category: 'CONTENT_CORRECTION',
      })
      expect(
        await db.venuePackage.findUniqueOrThrow({
          where: { id: applied.value.id },
          select: { status: true, approvedAt: true, appliedAt: true, revertedAt: true },
        }),
      ).toEqual({ status: 'DRAFT', approvedAt: null, appliedAt: null, revertedAt: null })
      expect(
        await db.approvalGrant.findUniqueOrThrow({
          where: { id: grant.id },
          select: { mode: true, useCount: true, maxUses: true },
        }),
      ).toEqual({ mode: 'ONE_SHOT', useCount: 1, maxUses: 1 })
    })
  })
})
