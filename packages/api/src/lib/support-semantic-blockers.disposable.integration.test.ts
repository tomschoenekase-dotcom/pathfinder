import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  db,
  prepareSupportKnowledgeProposalAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'
import { createSemanticUniversalContentDraftService } from './semantic-universal-content-handoff-service'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const enabled =
  process.env.RUN_SUPPORT_SEMANTIC_BLOCKERS_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_blockers_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

describe.skipIf(!enabled)('support semantic blockers on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('persists one conflict question and leaves duplicate content unchanged', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-support-blockers-${suffix}`
    const venueId = `venue-support-blockers-${suffix}`
    const adminId = `admin-support-blockers-${suffix}`
    const identityId = `agent-support-blockers-${suffix}`
    const entryId = `entry-support-blockers-${suffix}`
    const canonical = {
      title: `Willow gallery hours ${suffix}`,
      category: 'Hours',
      content: 'The Willow gallery closes at 5 PM.',
      isEnabled: true,
    }
    const conflicting = { ...canonical, content: 'The Willow gallery closes at 7 PM.' }
    const fixtureRows: Array<{ requestId: string; version: number; messageId: string }> = []

    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Support blockers fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Support blockers venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `support.blockers.${suffix}`,
          name: 'Support blockers content specialist',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['content.draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: adminId,
        },
      })
      await db.venueKnowledgeEntry.create({
        data: {
          id: entryId,
          tenantId,
          venueId,
          ...canonical,
          visibility: 'PUBLIC',
          lastReviewedAt: new Date(),
          lastReviewedBy: adminId,
          humanConfirmedAt: new Date(),
          humanConfirmedBy: adminId,
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
        },
      })
      for (const [subject, body] of [
        ['Conflicting Willow gallery hours', conflicting.content],
        ['Duplicate Willow gallery hours', canonical.content],
      ] as const) {
        const request = await db.supportRequest.create({
          data: {
            tenantId,
            venueId,
            category: 'CONTENT_CORRECTION',
            status: 'IN_REVIEW',
            subject,
            createdByKind: 'OPERATOR',
            createdById: adminId,
            updatedByKind: 'OPERATOR',
            updatedById: adminId,
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
            body,
            submissionRequestId: randomUUID(),
            submissionInputHash: createHash('sha256').update(body).digest('hex'),
            requestVersion: request.version,
            clientVersion: request.clientVersion,
          },
        })
        fixtureRows.push({ requestId: request.id, version: request.version, messageId: message.id })
      }
    })

    const caller = app.createCaller(context(adminId)).admin
    const prepareReviewedProposal = async (
      row: (typeof fixtureRows)[number],
      proposedChange: string,
    ) => {
      const operationId = randomUUID()
      await prepareSupportKnowledgeProposalAction({
        operationId,
        tenantId,
        venueId,
        supportRequestId: row.requestId,
        expectedVersion: row.version,
        evidenceMessageIds: [row.messageId],
        targetKnowledgeEntryId: entryId,
        correctionKind: 'UPDATE_KNOWLEDGE',
        aiInference: 'The retained support evidence concerns the current Willow gallery hours.',
        proposedChange,
        reason: 'Preserve the exact support evidence for human semantic review.',
        confidence: 0.9,
        actor: {
          type: 'AGENT',
          actorId: identityId,
          role: 'AGENT',
          agentIdentityId: identityId,
          agentRunId: `run-${operationId}`,
          workerId: `worker-support-blockers-${suffix}`,
          credentialId: `credential-support-blockers-${suffix}`,
          capability: 'knowledge:draft',
          idempotencyKey: operationId,
          modelProvider: 'deterministic-fixture',
          modelName: 'support-blockers-v1',
        },
      })
      const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
        where: { id: operationId, tenantId, venueId },
        select: { updatedAt: true },
      })
      await caller.reviewKnowledgeProposal({
        operationId: randomUUID(),
        tenantId,
        venueId,
        proposalId: operationId,
        expectedUpdatedAt: pending.updatedAt.toISOString(),
        decision: 'APPROVED',
        reviewNote:
          'The retained support evidence is reviewed; semantic blockers remain authoritative.',
      })
      return db.knowledgeChangeProposal.findFirstOrThrow({
        where: { id: operationId, tenantId, venueId },
        select: { id: true, updatedAt: true },
      })
    }

    const conflictProposal = await prepareReviewedProposal(fixtureRows[0]!, conflicting.content)
    const conflictPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: conflictProposal.id,
      expectedUpdatedAt: conflictProposal.updatedAt,
      relation: 'CORRECTS',
      desired: conflicting,
    })
    expect(conflictPreview).toMatchObject({
      classification: 'CONFLICT',
      operationCount: 0,
      venuePackagePatch: null,
      questions: [{ blockerCodes: ['LOWER_AUTHORITY_CONFLICT'] }],
    })
    await expect(
      createSemanticUniversalContentDraftService({
        db,
        actorId: adminId,
        input: {
          tenantId,
          venueId,
          proposalId: conflictProposal.id,
          expectedProposalUpdatedAt: conflictProposal.updatedAt.toISOString(),
          expectedPreviewHash: conflictPreview.previewHash,
          relation: 'CORRECTS',
          desired: conflicting,
          draft: {
            audience: 'PUBLIC',
            evidence: [
              {
                sourceId: `support-message:${fixtureRows[0]!.messageId}`,
                locator: `support-request:${fixtureRows[0]!.requestId}`,
                capturedAt: new Date().toISOString(),
                excerptHash: createHash('sha256').update(conflicting.content).digest('hex'),
              },
            ],
            payload: {
              kind: 'POLICY',
              title: conflicting.title,
              rule: conflicting.content,
              appliesTo: [],
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const questionInput = {
      tenantId,
      venueId,
      proposalId: conflictProposal.id,
      expectedUpdatedAt: conflictProposal.updatedAt,
      expectedPreviewHash: conflictPreview.previewHash,
      relation: 'CORRECTS' as const,
      desired: conflicting,
      agentIdentityId: identityId,
    }
    const questions = await Promise.all([
      caller.createSemanticConflictQuestion(questionInput),
      caller.createSemanticConflictQuestion(questionInput),
    ])
    expect(new Set(questions.map((result) => result.questionId))).toHaveProperty('size', 1)
    expect(questions.map((result) => result.replayed).sort()).toEqual([false, true])
    const firstQuestion = questions[0]!
    expect(firstQuestion).toMatchObject({
      questionStatus: 'PENDING',
      previewHash: conflictPreview.previewHash,
      executionTriggered: false,
      approvalGranted: false,
      canonicalKnowledgeChanged: false,
    })
    await expect(caller.createSemanticConflictQuestion(questionInput)).resolves.toMatchObject({
      questionId: firstQuestion.questionId,
      replayed: true,
    })
    const persistedQuestion = await db.agentQuestion.findFirstOrThrow({
      where: { id: firstQuestion.questionId, tenantId, venueId },
      select: { callbackMetadata: true, blocking: true, status: true },
    })
    expect(persistedQuestion).toMatchObject({
      callbackMetadata: {
        workflow: 'semantic-venue-update',
        proposalId: conflictProposal.id,
        previewHash: conflictPreview.previewHash,
        classification: 'CONFLICT',
        blockerCodes: 'LOWER_AUTHORITY_CONFLICT',
      },
      blocking: true,
      status: 'PENDING',
    })

    const duplicateProposal = await prepareReviewedProposal(fixtureRows[1]!, canonical.content)
    const duplicatePreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: duplicateProposal.id,
      expectedUpdatedAt: duplicateProposal.updatedAt,
      relation: 'CORRECTS',
      desired: canonical,
    })
    expect(duplicatePreview).toMatchObject({
      classification: 'DUPLICATE_NOOP',
      operationCount: 0,
      venuePackagePatch: null,
    })
    const duplicateQuestionInput = {
      ...questionInput,
      proposalId: duplicateProposal.id,
      expectedUpdatedAt: duplicateProposal.updatedAt,
      expectedPreviewHash: duplicatePreview.previewHash,
      desired: canonical,
    }
    await expect(
      caller.createSemanticConflictQuestion(duplicateQuestionInput),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    await expect(
      caller.createSemanticConflictQuestion(duplicateQuestionInput),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    const duplicateDraft = {
      audience: 'PUBLIC' as const,
      evidence: [
        {
          sourceId: `support-message:${fixtureRows[1]!.messageId}`,
          locator: `support-request:${fixtureRows[1]!.requestId}`,
          capturedAt: new Date().toISOString(),
          excerptHash: createHash('sha256').update(canonical.content).digest('hex'),
        },
      ],
      payload: {
        kind: 'POLICY' as const,
        title: canonical.title,
        rule: canonical.content,
        appliesTo: [],
      },
    }
    await expect(
      createSemanticUniversalContentDraftService({
        db,
        actorId: adminId,
        input: {
          tenantId,
          venueId,
          proposalId: duplicateProposal.id,
          expectedProposalUpdatedAt: duplicateProposal.updatedAt.toISOString(),
          expectedPreviewHash: duplicatePreview.previewHash,
          relation: 'CORRECTS',
          desired: canonical,
          draft: duplicateDraft,
        },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const final = await Promise.all([
      db.agentQuestion.count({ where: { tenantId, venueId } }),
      db.agentQuestionOperation.count({ where: { tenantId, venueId } }),
      db.knowledgeProposalUniversalContentHandoff.count({ where: { tenantId, venueId } }),
      db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
      db.contentModuleRevision.count({ where: { tenantId, venueId } }),
      db.contentModulePublication.count({ where: { tenantId, venueId } }),
      db.venueKnowledgeEntry.findFirstOrThrow({
        where: { id: entryId, tenantId, venueId },
        select: { title: true, category: true, content: true, isEnabled: true },
      }),
    ])
    expect(final.slice(0, 6)).toEqual([1, 1, 0, 0, 0, 0])
    expect(final[6]).toEqual(canonical)
  })
})
