import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  db,
  prepareSupportKnowledgeProposalAction,
  readSupportPackageFulfillment,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'
import { hashSemanticConflictTarget } from './semantic-conflict-resolution-contract'

const enabled =
  process.env.RUN_SUPPORT_ADDITION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_addition_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

describe.skipIf(!enabled)('semantic duplicate on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())
  it('records one immutable reviewed support duplicate without changing canonical content', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-duplicate-${suffix}`,
      venueId = `venue-duplicate-${suffix}`,
      adminId = `admin-duplicate-${suffix}`
    const scope = { tenantId, venueId }
    const desired = {
      title: `Quiet room ${suffix}`,
      category: 'Visitor services',
      content: 'The quiet room is beside the east gallery.',
      isEnabled: true,
    }
    const caller = app.createCaller({
      db,
      headers: new Headers(),
      session: { userId: adminId, activeTenantId: null, role: null, isPlatformAdmin: true },
    } as TRPCContext).admin
    let requestId = '',
      requestVersion = 0,
      messageId = '',
      targetId = ''
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Duplicate fixture', slug: tenantId } })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { tenantId, id: venueId, name: 'Duplicate venue', slug: venueId },
      })
      const request = await db.supportRequest.create({
        data: {
          ...scope,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Confirm quiet room',
          createdByKind: 'OPERATOR',
          createdById: adminId,
          updatedByKind: 'OPERATOR',
          updatedById: adminId,
        },
      })
      requestId = request.id
      requestVersion = request.version
      await db.supportRequestAuditEvent.create({
        data: {
          ...scope,
          supportRequestId: requestId,
          requestVersion,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: adminId,
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        },
      })
      const message = await db.supportMessage.create({
        data: {
          ...scope,
          supportRequestId: requestId,
          authorKind: 'CLIENT',
          authorId: adminId,
          visibility: 'CLIENT_VISIBLE',
          body: desired.content,
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion,
          clientVersion: request.clientVersion,
        },
      })
      messageId = message.id
      const target = await db.venueKnowledgeEntry.create({
        data: {
          ...scope,
          ...desired,
          visibility: 'PUBLIC',
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
        },
      })
      targetId = target.id
    })
    const proposalId = randomUUID()
    await prepareSupportKnowledgeProposalAction({
      operationId: proposalId,
      ...scope,
      supportRequestId: requestId,
      expectedVersion: requestVersion,
      evidenceMessageIds: [messageId],
      correctionKind: 'CREATE_KNOWLEDGE',
      aiInference: 'The support request repeats existing guidance.',
      proposedChange: desired.content,
      reason: 'Review existing guidance before making a change.',
      confidence: 0.9,
      actor: {
        type: 'AGENT',
        actorId: `agent-${suffix}`,
        role: 'AGENT',
        agentIdentityId: `agent-${suffix}`,
        agentRunId: `run-${suffix}`,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        capability: 'knowledge:draft',
        idempotencyKey: proposalId,
        modelProvider: 'deterministic-fixture',
        modelName: 'duplicate-fixture',
      },
    })
    const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: proposalId },
    })
    await caller.reviewKnowledgeProposal({
      operationId: randomUUID(),
      ...scope,
      proposalId,
      expectedUpdatedAt: pending.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'Review the exact repeat of existing guidance.',
    })
    const approved = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: proposalId },
    })
    const preview = await previewSemanticVenueUpdateFromProposal({
      db,
      ...scope,
      proposalId,
      expectedUpdatedAt: approved.updatedAt,
      relation: 'NEW_FACT',
      desired,
    })
    expect(preview.classification).toBe('DUPLICATE_NOOP')
    expect(preview.targetKnowledgeEntryId).toBeNull()
    expect(preview.duplicateMatch?.knowledgeEntryId).toBe(targetId)
    const targetBefore = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { ...scope, id: targetId },
    })
    const input = {
      operationId: randomUUID(),
      ...scope,
      proposalId,
      expectedProposalUpdatedAt: approved.updatedAt.toISOString(),
      expectedPreviewHash: preview.previewHash,
      relation: 'NEW_FACT' as const,
      desired,
      resolutionNote: 'The approved request already matches this exact canonical entry.',
    }
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, expectedPreviewHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const results = await Promise.all([
      caller.resolveSupportSemanticDuplicate(input),
      caller.resolveSupportSemanticDuplicate(input),
    ])
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true])
    expect(results[0]).toMatchObject({
      resolutionId: input.operationId,
      outcome: 'DUPLICATE_NOOP',
      completionGranted: false,
      currentFulfillmentVerified: false,
      canonicalKnowledgeChanged: false,
    })
    const receipt = await db.semanticDuplicateResolution.findFirstOrThrow({
      where: { ...scope, id: input.operationId },
    })
    expect(receipt.targetKnowledgeEntryId).toBe(targetId)
    expect(receipt.targetSnapshotHash).toBe(
      hashSemanticConflictTarget({
        id: targetBefore.id,
        title: targetBefore.title,
        category: targetBefore.category,
        content: targetBefore.content,
        isEnabled: targetBefore.isEnabled,
        humanConfirmedAt: targetBefore.humanConfirmedAt,
        authorship: targetBefore.authorship,
        sourceType: targetBefore.sourceType,
      }),
    )
    expect(receipt.sourceEvidence).toEqual([
      expect.objectContaining({
        sourceId: `support-message:${messageId}`,
        locator: `support-request:${requestId}`,
        excerptHash: createHash('sha256').update(desired.content).digest('hex'),
      }),
    ])
    expect(await db.semanticDuplicateResolution.count({ where: { ...scope, proposalId } })).toBe(1)
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, resolutionNote: 'Changed decision' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(
      await db.venueKnowledgeEntry.findFirstOrThrow({ where: { ...scope, id: targetId } }),
    ).toEqual(targetBefore)
    expect(
      await db.knowledgeChangeProposal.findFirstOrThrow({ where: { ...scope, id: proposalId } }),
    ).toEqual(approved)
    expect(await db.knowledgeProposalUniversalContentHandoff.count({ where: scope })).toBe(0)
    expect(await db.knowledgeProposalPackageHandoff.count({ where: scope })).toBe(0)
    expect(await db.knowledgeProposalOperationalUpdateHandoff.count({ where: scope })).toBe(0)
    expect(await db.legacyKnowledgeUniversalContentAdoption.count({ where: scope })).toBe(0)
    await expect(
      db.semanticDuplicateResolution.updateMany({
        where: { ...scope, id: receipt.id },
        data: { resolutionNote: 'Rewrite' },
      }),
    ).rejects.toThrow('append-only')
    await expect(
      db.semanticDuplicateResolution.deleteMany({ where: { ...scope, id: receipt.id } }),
    ).rejects.toThrow('append-only')
    expect(
      await db.semanticDuplicateResolution.findFirst({
        where: { tenantId: 'other-tenant', venueId, id: receipt.id },
      }),
    ).toBeNull()
    // Recording a reviewed decision does not yet bypass the shared completion gate.
    await expect(
      readSupportPackageFulfillment(db, { ...scope, supportRequestId: requestId }),
    ).rejects.toThrow()
  }, 30000)
})
