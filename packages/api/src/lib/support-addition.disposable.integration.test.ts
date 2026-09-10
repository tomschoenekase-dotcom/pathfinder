import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  db,
  prepareSupportKnowledgeProposalAction,
  publishUniversalContentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'
import { retrieveGuestKnowledge } from './guest-knowledge-retrieval'
import { createSemanticUniversalContentDraftService } from './semantic-universal-content-handoff-service'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const enabled =
  process.env.RUN_SUPPORT_ADDITION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_addition_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

describe.skipIf(!enabled)('support addition on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('publishes a reviewed support addition once and retrieves the new fact', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-support-addition-${suffix}`
    const venueId = `venue-support-addition-${suffix}`
    const adminId = `admin-support-addition-${suffix}`
    const operationId = randomUUID()
    const uniqueFact = `The Juniper quiet room is beside gallery ${suffix}.`
    const siblingId = `sibling-support-addition-${suffix}`
    let supportRequestId = ''
    let supportVersion = 0
    let evidenceMessageId = ''

    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Support addition fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Support addition venue', slug: venueId },
      })
      const request = await db.supportRequest.create({
        data: {
          tenantId,
          venueId,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Add the Juniper quiet room location',
          createdByKind: 'OPERATOR',
          createdById: adminId,
          updatedByKind: 'OPERATOR',
          updatedById: adminId,
        },
      })
      supportRequestId = request.id
      supportVersion = request.version
      await db.supportRequestAuditEvent.create({
        data: {
          tenantId,
          venueId,
          supportRequestId: request.id,
          requestVersion: request.version,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: adminId,
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
          authorId: adminId,
          visibility: 'CLIENT_VISIBLE',
          body: uniqueFact,
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion: request.version,
          clientVersion: request.clientVersion,
        },
      })
      evidenceMessageId = message.id
      await db.venueKnowledgeEntry.create({
        data: {
          id: siblingId,
          tenantId,
          venueId,
          title: 'Unrelated coat check',
          category: 'Visitor services',
          content: 'The coat check remains beside the west entrance.',
          visibility: 'PUBLIC',
          isEnabled: true,
          lastReviewedAt: new Date(),
          lastReviewedBy: adminId,
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
        },
      })
    })

    const proposalInput = {
      operationId,
      tenantId,
      venueId,
      supportRequestId,
      expectedVersion: supportVersion,
      evidenceMessageIds: [evidenceMessageId],
      correctionKind: 'CREATE_KNOWLEDGE' as const,
      aiInference: 'The reviewed support evidence describes an absent visitor-services fact.',
      proposedChange: uniqueFact,
      reason: 'Prepare the exact support evidence as a new fact for human review.',
      confidence: 0.92,
      actor: {
        type: 'AGENT' as const,
        actorId: `agent-support-addition-${suffix}`,
        role: 'AGENT' as const,
        agentIdentityId: `agent-support-addition-${suffix}`,
        agentRunId: `run-support-addition-${suffix}`,
        workerId: `worker-support-addition-${suffix}`,
        credentialId: `credential-support-addition-${suffix}`,
        capability: 'knowledge:draft' as const,
        idempotencyKey: operationId,
        modelProvider: 'deterministic-fixture',
        modelName: 'support-addition-v1',
      },
    }
    const prepared = await prepareSupportKnowledgeProposalAction(proposalInput)
    expect(prepared).toMatchObject({
      replayed: false,
      proposal: {
        id: operationId,
        status: 'PENDING_REVIEW',
        supportRequestId,
        supportRequestVersion: supportVersion,
      },
    })
    await expect(prepareSupportKnowledgeProposalAction(proposalInput)).resolves.toMatchObject({
      replayed: true,
      proposal: { id: operationId },
    })

    const desired = {
      title: `Juniper quiet room ${suffix}`,
      category: 'Visitor services',
      content: uniqueFact,
      isEnabled: true,
    }
    const pendingProposal = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { id: operationId, tenantId, venueId },
      select: { updatedAt: true },
    })
    const pendingPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: operationId,
      expectedUpdatedAt: pendingProposal.updatedAt,
      relation: 'NEW_FACT',
      desired,
    })
    expect(pendingPreview.classification).toBe('ADDITION')
    const draft = {
      audience: 'PUBLIC' as const,
      evidence: [
        {
          sourceId: `support-message:${evidenceMessageId}`,
          locator: `support-request:${supportRequestId}`,
          capturedAt: new Date().toISOString(),
          excerptHash: createHash('sha256').update(uniqueFact).digest('hex'),
        },
      ],
      payload: {
        kind: 'POLICY' as const,
        title: desired.title,
        rule: desired.content,
        appliesTo: [],
      },
    }
    const pendingDraftInput = {
      tenantId,
      venueId,
      proposalId: operationId,
      expectedProposalUpdatedAt: pendingProposal.updatedAt.toISOString(),
      expectedPreviewHash: pendingPreview.previewHash,
      relation: 'NEW_FACT' as const,
      desired,
      draft,
    }
    await expect(
      createSemanticUniversalContentDraftService({
        db,
        actorId: adminId,
        input: pendingDraftInput,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const caller = app.createCaller(context(adminId)).admin
    await caller.reviewKnowledgeProposal({
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId: operationId,
      expectedUpdatedAt: pendingProposal.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'The support evidence verifies this addition; publication remains separate.',
    })
    const approvedProposal = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { id: operationId, tenantId, venueId },
      select: { updatedAt: true, status: true },
    })
    expect(approvedProposal.status).toBe('APPROVED')
    const approvedPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: operationId,
      expectedUpdatedAt: approvedProposal.updatedAt,
      relation: 'NEW_FACT',
      desired,
    })
    expect(approvedPreview.classification).toBe('ADDITION')
    const approvedDraftInput = {
      ...pendingDraftInput,
      expectedProposalUpdatedAt: approvedProposal.updatedAt.toISOString(),
      expectedPreviewHash: approvedPreview.previewHash,
    }
    const created = await createSemanticUniversalContentDraftService({
      db,
      actorId: adminId,
      input: approvedDraftInput,
    })
    expect(created).toMatchObject({ classification: 'ADDITION', version: 1, replayed: false })

    const guestRead = () =>
      retrieveGuestKnowledge({
        reader: db,
        query: `Where is the Juniper quiet room ${suffix}?`,
        tenantId,
        venueId,
        includeSecondLayer: false,
        queryEmbedding: null,
      })
    expect((await guestRead()).entries.map((entry) => entry.content)).not.toContain(uniqueFact)
    const countsBeforePublish = await Promise.all([
      db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
      db.contentModuleRevision.count({ where: { tenantId, venueId } }),
      db.contentModulePublication.count({ where: { tenantId, venueId } }),
    ])
    expect(countsBeforePublish).toEqual([1, 1, 0])

    const publishRequestId = randomUUID()
    const publicationInput = {
      db,
      tenantId,
      venueId,
      moduleId: created.moduleId,
      revisionId: created.revisionId,
      expectedLatestVersion: 1,
      requestId: publishRequestId,
      actor: { type: 'HUMAN' as const, id: adminId, role: 'PLATFORM_ADMIN' as const },
    }
    const published = await publishUniversalContentAction(publicationInput)
    expect(published).toMatchObject({ replayed: false })
    expect((await guestRead()).entries.map((entry) => entry.content)).toContain(uniqueFact)

    const draftReplay = await createSemanticUniversalContentDraftService({
      db,
      actorId: adminId,
      input: approvedDraftInput,
    })
    expect(draftReplay).toMatchObject({
      moduleId: created.moduleId,
      revisionId: created.revisionId,
      classification: 'ADDITION',
      replayed: true,
    })
    const publicationReplay = await publishUniversalContentAction(publicationInput)
    expect(publicationReplay).toMatchObject({
      publicationId: published.publicationId,
      replayed: true,
    })
    const final = await Promise.all([
      db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
      db.contentModuleRevision.count({ where: { tenantId, venueId } }),
      db.contentModulePublication.count({ where: { tenantId, venueId } }),
      db.venueKnowledgeEntry.findFirstOrThrow({
        where: { id: siblingId, tenantId, venueId },
        select: { title: true, content: true, isEnabled: true, contentModuleId: true },
      }),
    ])
    expect(final.slice(0, 3)).toEqual([1, 1, 1])
    expect(final[3]).toEqual({
      title: 'Unrelated coat check',
      content: 'The coat check remains beside the west entrance.',
      isEnabled: true,
      contentModuleId: null,
    })
  })
})
