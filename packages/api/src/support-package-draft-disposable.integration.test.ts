import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { SupportPackageApprovalApplyParameters } from '@pathfinder/contracts'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

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
  createOrReplayEvaluationRun,
  db,
  evaluationSnapshotHash,
  issueApprovalGrantAction,
  prepareSupportPackageDraftProposalAction,
  recordApprovalDecisionAction,
  supportPackageDraftPayloadHash,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { supportAgentReviewedDraftFinalizer } from './lib/admin-reviewed-draft-finalizers'
import { loadReviewableVenuePackageEvaluationPreview } from './lib/reviewable-package-evaluation'
import { prepareSupportPackageApprovalProposalAction } from './lib/support-package-approval-actions'
import { approveVenuePackageLifecycle } from './lib/venue-package-core'
import { VenuePackageDraftInput } from './schemas/venue-package'
import { createVenuePackageDraftService } from './routers/venue-package'

const enabled =
  process.env.RUN_SUPPORT_PACKAGE_DRAFT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_package_draft_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('support package-draft disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('creates, evaluates, and founder-approves one exact support-linked V3 package without applying it', async () => {
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

      const reviewed = await db.$transaction((tx) =>
        loadReviewableVenuePackageEvaluationPreview(tx, tenantId, {
          venueId,
          packageId: applied.value.id,
        }),
      )
      expect(reviewed.package).toMatchObject({
        id: applied.value.id,
        status: 'DRAFT',
        payloadHash: applied.value.payloadHash,
      })
      expect(reviewed.preview).toMatchObject({
        package: { id: applied.value.id, status: 'DRAFT' },
        published: false,
        guestAccessible: false,
      })

      const contentSnapshot = {
        version: 'pathfinder-reviewable-package-evaluation-content-v1',
        tenantId,
        venueId,
        packageId: reviewed.package.id,
        packageStatus: reviewed.package.status,
        payloadHash: reviewed.package.payloadHash,
        baseDigest: reviewed.package.baseDigest,
        preview: reviewed.preview,
      }
      const runId = randomUUID()
      const evaluation = await createOrReplayEvaluationRun({
        db,
        runId,
        identity: {
          tenantId,
          venueId,
          idempotencyKey: `support-package-review:${applied.value.id}`,
          caseManifest: [{ caseId: randomUUID(), revision: 1, caseHash: 'a'.repeat(64) }],
          promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
          promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
          packageSnapshotRef: `venue-package-review-v1:${applied.value.id}`,
          packageSnapshotHash: reviewed.package.payloadHash,
          contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1',
          contentSnapshotRef: applied.value.id,
          contentSnapshotVersion: 1n,
          contentSnapshotHash: evaluationSnapshotHash(
            'pathfinder-reviewable-package-evaluation-content-v1',
            contentSnapshot,
          ),
          modelProvider: 'synthetic',
          modelName: 'provider-dark-review-proof',
          modelSnapshot: { execution: 'DISABLED', reason: 'provider-dark shakedown' },
          runConfigSnapshot: {
            version: 'pathfinder-reviewable-package-evaluation-run-config-v1',
            contentSnapshot,
          },
          declaredBudgetCeilingE8Usd: 0n,
          createdBy: operatorId,
          triggerType: 'DISPOSABLE_SUPPORT_PACKAGE_REVIEW',
        },
      })
      expect(evaluation).toMatchObject({ replayed: false, run: { id: runId, status: 'STAGED' } })
      expect(
        await db.venuePackage.findUniqueOrThrow({
          where: { id: applied.value.id },
          select: { status: true, approvedAt: true, appliedAt: true },
        }),
      ).toEqual({ status: 'DRAFT', approvedAt: null, appliedAt: null })
      expect(
        await db.supportPackageHandoff.findFirstOrThrow({
          where: { tenantId, venueId, venuePackageId: applied.value.id },
          select: { supportRequestId: true, venuePackageId: true },
        }),
      ).toEqual({ supportRequestId: request.id, venuePackageId: applied.value.id })
      expect(
        await db.evalRun.findUniqueOrThrow({
          where: { id: runId },
          select: {
            contentSnapshotKind: true,
            contentSnapshotRef: true,
            packageSnapshotHash: true,
            status: true,
          },
        }),
      ).toEqual({
        contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1',
        contentSnapshotRef: applied.value.id,
        packageSnapshotHash: reviewed.package.payloadHash,
        status: 'STAGED',
      })

      const approvalIdentityId = `identity-package-approval-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: approvalIdentityId,
          tenantId,
          venueId,
          identityKey: `support-package-approval.${suffix}`,
          name: 'Support package approval worker',
          agentType: 'SUPPORT',
          accessScope: 'VENUE',
          accessCapabilities: ['packages:approve'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: operatorId,
        },
      })
      const approvalRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: approvalIdentityId,
          runType: 'SUPPORT',
          requestedOperation: 'support.package-approval.propose',
          scopeSnapshot: { accessCapabilities: ['packages:approve'] },
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: operatorId,
          startedAt: new Date(),
        },
      })
      const packageBeforeApproval = await db.venuePackage.findUniqueOrThrow({
        where: { id: applied.value.id },
        select: { updatedAt: true },
      })
      const approvalProposalOperationId = randomUUID()
      const approvalProposal = await prepareSupportPackageApprovalProposalAction({
        operationId: approvalProposalOperationId,
        tenantId,
        venueId,
        packageId: applied.value.id,
        expectedUpdatedAt: packageBeforeApproval.updatedAt,
        reason: 'The exact support-linked package and evaluation evidence are ready for review.',
        evidence: [
          { type: 'SupportRequest', id: request.id },
          { type: 'EvalRun', id: runId },
        ],
        actor: {
          type: 'AGENT',
          actorId: approvalIdentityId,
          role: 'AGENT',
          agentIdentityId: approvalIdentityId,
          agentRunId: approvalRun.id,
          workerId: `approval-worker-${suffix}`,
          credentialId: `approval-credential-${suffix}`,
          capability: 'packages:approve',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: approvalProposalOperationId,
        },
      })
      expect(approvalProposal).toMatchObject({
        replayed: false,
        snapshot: {
          packageId: applied.value.id,
          fromStatus: 'DRAFT',
          toStatus: 'APPROVED',
          evaluationEvidence: {
            exactPackageRunIds: [runId],
            thresholdApplied: false,
          },
          packageApproved: false,
          packageApplied: false,
          packagePublished: false,
        },
      })
      expect(
        prepareSupportPackageApprovalProposalAction({
          operationId: approvalProposalOperationId,
          tenantId,
          venueId,
          packageId: applied.value.id,
          expectedUpdatedAt: packageBeforeApproval.updatedAt,
          reason: 'The exact support-linked package and evaluation evidence are ready for review.',
          evidence: [
            { type: 'SupportRequest', id: request.id },
            { type: 'EvalRun', id: runId },
          ],
          actor: {
            type: 'AGENT',
            actorId: approvalIdentityId,
            role: 'AGENT',
            agentIdentityId: approvalIdentityId,
            agentRunId: approvalRun.id,
            workerId: `approval-worker-${suffix}`,
            credentialId: `approval-credential-${suffix}`,
            capability: 'packages:approve',
            modelProvider: 'deterministic',
            modelName: 'fixture',
            idempotencyKey: approvalProposalOperationId,
          },
        }),
      ).resolves.toMatchObject({ replayed: true })

      const approvalDecision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: approvalProposalOperationId,
        decision: 'APPROVED',
        reason: 'Approve only this exact DRAFT; package application remains separate.',
        actor: { actorType: 'HUMAN', actorId: operatorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const approvalParameters = SupportPackageApprovalApplyParameters.parse({
        clientId: tenantId,
        venueId,
        packageId: approvalProposal.snapshot.packageId,
        expectedUpdatedAt: approvalProposal.snapshot.expectedUpdatedAt,
        payloadHash: approvalProposal.snapshot.payloadHash,
        baseDigest: approvalProposal.snapshot.baseDigest,
        warningDigest: approvalProposal.snapshot.warningDigest,
        supportHandoff: approvalProposal.snapshot.supportHandoff,
      })
      const approvalGrant = await issueApprovalGrantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: approvalIdentityId,
        actionName: 'pathfinder.apply_support_package_approval',
        capability: 'packages:approve',
        mode: 'ONE_SHOT',
        scope: {
          contractVersion: 1,
          tenantId,
          venueId,
          approvalRequestId: approvalProposalOperationId,
          effect: 'EXACT_SUPPORT_LINKED_PACKAGE_DRAFT_TO_APPROVED_ONLY',
        },
        parameters: approvalParameters,
        approvalDecisionId: approvalDecision.id,
        issueReason: 'Execute this exact reviewed package approval once.',
        actor: { type: 'HUMAN', id: operatorId, role: 'PLATFORM_ADMIN' },
      })
      const approvalApplyOperationId = randomUUID()
      const approvalActor = {
        type: 'AGENT' as const,
        actorId: approvalIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: approvalIdentityId,
        agentRunId: approvalRun.id,
        workerId: `approval-worker-${suffix}`,
        credentialId: `approval-credential-${suffix}`,
        approvalGrantId: approvalGrant.id,
        capability: 'packages:approve',
        modelProvider: 'deterministic',
        modelName: 'fixture',
        idempotencyKey: approvalApplyOperationId,
      }
      const approve = () =>
        db.$transaction(async (tx) => {
          const sameTransaction = {
            $transaction: async (callback: (inner: typeof tx) => unknown) => callback(tx),
          } as never
          const consumption = await consumeApprovalGrantAction(
            {
              tenantId,
              venueId,
              approvalGrantId: approvalGrant.id,
              operationId: approvalApplyOperationId,
              actionName: 'pathfinder.apply_support_package_approval',
              capability: 'packages:approve',
              parameters: approvalParameters,
              actor: approvalActor,
            },
            sameTransaction,
          )
          const approved = await approveVenuePackageLifecycle({
            db: sameTransaction,
            tenantId,
            venueId,
            actor: { type: 'HUMAN', id: operatorId, role: 'PLATFORM_ADMIN' },
            command: {
              id: approvalParameters.packageId,
              expectedUpdatedAt: new Date(approvalParameters.expectedUpdatedAt),
              commandKey: approvalApplyOperationId,
              acknowledgedPayloadHash: approvalParameters.payloadHash,
              acknowledgedWarningDigest: approvalParameters.warningDigest,
            },
          })
          const resultReference = `VenuePackage:${approved.id}:${approved.updatedAt.toISOString()}:APPROVED`
          if (consumption.replayed) {
            expect(consumption.consumption.resultReference).toBe(resultReference)
          } else {
            await tx.approvalGrantConsumption.update({
              where: { id: consumption.consumption.id },
              data: { resultReference },
            })
          }
          return { approved, replayed: consumption.replayed }
        })
      const approved = await approve()
      expect(approved).toMatchObject({
        replayed: false,
        approved: {
          id: applied.value.id,
          status: 'APPROVED',
          approvedBy: operatorId,
          appliedAt: null,
          revertedAt: null,
        },
      })
      await expect(approve()).resolves.toMatchObject({
        replayed: true,
        approved: { id: applied.value.id, status: 'APPROVED' },
      })
      await expect(
        consumeApprovalGrantAction({
          tenantId,
          venueId,
          approvalGrantId: approvalGrant.id,
          operationId: approvalApplyOperationId,
          actionName: 'pathfinder.apply_support_package_approval',
          capability: 'packages:approve',
          parameters: { ...approvalParameters, baseDigest: 'f'.repeat(64) },
          actor: approvalActor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(
        await db.venuePackage.findUniqueOrThrow({
          where: { id: applied.value.id },
          select: {
            status: true,
            approvedBy: true,
            approvedAt: true,
            appliedAt: true,
            revertedAt: true,
          },
        }),
      ).toMatchObject({
        status: 'APPROVED',
        approvedBy: operatorId,
        approvedAt: expect.any(Date),
        appliedAt: null,
        revertedAt: null,
      })
      expect(await db.supportMessage.count({ where: { tenantId, venueId } })).toBe(0)
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
    })
  })
})
