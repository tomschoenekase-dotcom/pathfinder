import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  db,
  prepareSupportKnowledgeProposalAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'
import { createSemanticUniversalContentDraftService } from './semantic-universal-content-handoff-service'
import { hashSemanticConflictAnswer } from './semantic-conflict-resolution-contract'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const enabled =
  process.env.RUN_SEMANTIC_CONFLICT_RESOLUTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_conflict_resolution_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

describe.skipIf(!enabled)('semantic conflict resolution on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('binds answered conflict to an unapproved replacement without changing canonical truth', async () => {
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
        ['Keep canonical Willow gallery hours', 'The Willow gallery closes at 8 PM.'],
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
      select: { callbackMetadata: true, blocking: true, status: true, updatedAt: true },
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
    const answer = 'Use the signed operations sheet and propose a 6 PM closing time.'
    await answerAgentQuestionAction({
      tenantId,
      venueId,
      questionId: firstQuestion.questionId,
      expectedUpdatedAt: persistedQuestion.updatedAt,
      outcome: 'ANSWERED',
      answer,
      actor: { actorType: 'HUMAN', actorId: adminId, auditRole: 'PLATFORM_ADMIN' },
    })
    const answered = await db.agentQuestion.findFirstOrThrow({
      where: { id: firstQuestion.questionId, tenantId, venueId },
      select: { updatedAt: true, answeredAt: true, answer: true },
    })
    expect(answered.answer).toBe(answer)
    expect(answered.answeredAt).not.toBeNull()
    const replacementDesired = { ...canonical, content: 'The Willow gallery closes at 6 PM.' }
    const resolutionInput = {
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId: conflictProposal.id,
      expectedProposalUpdatedAt: conflictProposal.updatedAt.toISOString(),
      expectedPreviewHash: conflictPreview.previewHash,
      questionId: firstQuestion.questionId,
      expectedQuestionUpdatedAt: answered.updatedAt.toISOString(),
      expectedAnsweredAt: answered.answeredAt!.toISOString(),
      expectedAnswerHash: hashSemanticConflictAnswer(answer),
      relation: 'CORRECTS' as const,
      desired: conflicting,
      replacementDesired,
      outcome: 'PROPOSE_REPLACEMENT' as const,
      resolutionNote:
        'The operator answer supports a new reviewable proposal; it does not approve it.',
    }
    await expect(
      caller.resolveSemanticConflict({
        ...resolutionInput,
        operationId: randomUUID(),
        expectedAnswerHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.resolveSemanticConflict({
        ...resolutionInput,
        operationId: randomUUID(),
        expectedQuestionUpdatedAt: persistedQuestion.updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const resolutions = await Promise.all([
      caller.resolveSemanticConflict(resolutionInput),
      caller.resolveSemanticConflict(resolutionInput),
    ])
    expect(new Set(resolutions.map((result) => result.resolutionId)).size).toBe(1)
    expect(new Set(resolutions.map((result) => result.replacementProposalId)).size).toBe(1)
    expect(resolutions.map((result) => result.replayed).sort()).toEqual([false, true])
    for (const result of resolutions)
      expect(result).toMatchObject({
        outcome: 'PROPOSE_REPLACEMENT',
        canonicalKnowledgeChanged: false,
        approvalGranted: false,
      })
    const resolution = resolutions[0]!
    expect(resolution.replacementProposalId).not.toBeNull()
    await expect(
      caller.resolveSemanticConflict({
        ...resolutionInput,
        operationId: randomUUID(),
        venueId: `foreign-${venueId}`,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|CONFLICT/u) })

    const proposals = await db.knowledgeChangeProposal.findMany({
      where: {
        id: { in: [conflictProposal.id, resolution.replacementProposalId!] },
        tenantId,
        venueId,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, updatedAt: true, targetKnowledgeEntryId: true },
    })
    expect(proposals).toEqual([
      expect.objectContaining({ id: conflictProposal.id, status: 'REJECTED' }),
      expect.objectContaining({
        id: resolution.replacementProposalId,
        status: 'PENDING_REVIEW',
        targetKnowledgeEntryId: entryId,
      }),
    ])
    const replacement = proposals.find(
      (proposal) => proposal.id === resolution.replacementProposalId,
    )!
    const pendingReplacementPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: replacement.id,
      expectedUpdatedAt: replacement.updatedAt,
      relation: 'CORRECTS',
      desired: replacementDesired,
    })
    expect(pendingReplacementPreview).toMatchObject({
      classification: 'CONFLICT',
      operatorResolutionId: null,
      authority: 'UNVERIFIED',
    })
    await caller.reviewKnowledgeProposal({
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId: replacement.id,
      expectedUpdatedAt: replacement.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'Approve the replacement proposal for semantic classification only.',
    })
    const approvedReplacement = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { id: replacement.id, tenantId, venueId },
      select: { updatedAt: true },
    })
    const replacementPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: replacement.id,
      expectedUpdatedAt: approvedReplacement.updatedAt,
      relation: 'CORRECTS',
      desired: replacementDesired,
    })
    expect(replacementPreview).toMatchObject({
      classification: 'CORRECTION',
      authority: 'TRUSTED_PARTNER',
      operatorResolutionId: resolution.resolutionId,
      targetKnowledgeEntryId: entryId,
    })

    const keepDesired = { ...canonical, content: 'The Willow gallery closes at 8 PM.' }
    const keepProposal = await prepareReviewedProposal(fixtureRows[1]!, keepDesired.content)
    const keepPreview = await previewSemanticVenueUpdateFromProposal({
      db,
      tenantId,
      venueId,
      proposalId: keepProposal.id,
      expectedUpdatedAt: keepProposal.updatedAt,
      relation: 'CORRECTS',
      desired: keepDesired,
    })
    expect(keepPreview).toMatchObject({
      classification: 'CONFLICT',
      questions: [{ blockerCodes: ['LOWER_AUTHORITY_CONFLICT'] }],
    })
    const keepQuestion = await caller.createSemanticConflictQuestion({
      tenantId,
      venueId,
      proposalId: keepProposal.id,
      expectedUpdatedAt: keepProposal.updatedAt,
      expectedPreviewHash: keepPreview.previewHash,
      relation: 'CORRECTS',
      desired: keepDesired,
      agentIdentityId: identityId,
    })
    const pendingKeepQuestion = await db.agentQuestion.findFirstOrThrow({
      where: { id: keepQuestion.questionId, tenantId, venueId },
      select: { updatedAt: true },
    })
    const keepAnswer = 'Keep the existing human-confirmed 5 PM closing time.'
    await answerAgentQuestionAction({
      tenantId,
      venueId,
      questionId: keepQuestion.questionId,
      expectedUpdatedAt: pendingKeepQuestion.updatedAt,
      outcome: 'ANSWERED',
      answer: keepAnswer,
      actor: { actorType: 'HUMAN', actorId: adminId, auditRole: 'PLATFORM_ADMIN' },
    })
    const answeredKeepQuestion = await db.agentQuestion.findFirstOrThrow({
      where: { id: keepQuestion.questionId, tenantId, venueId },
      select: { updatedAt: true, answeredAt: true },
    })
    const kept = await caller.resolveSemanticConflict({
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId: keepProposal.id,
      expectedProposalUpdatedAt: keepProposal.updatedAt.toISOString(),
      expectedPreviewHash: keepPreview.previewHash,
      questionId: keepQuestion.questionId,
      expectedQuestionUpdatedAt: answeredKeepQuestion.updatedAt.toISOString(),
      expectedAnsweredAt: answeredKeepQuestion.answeredAt!.toISOString(),
      expectedAnswerHash: hashSemanticConflictAnswer(keepAnswer),
      relation: 'CORRECTS',
      desired: keepDesired,
      outcome: 'KEEP_CANONICAL',
      resolutionNote: 'The operator explicitly retained the existing human-confirmed guidance.',
    })
    expect(kept).toMatchObject({
      outcome: 'KEEP_CANONICAL',
      replacementProposalId: null,
      replayed: false,
      canonicalKnowledgeChanged: false,
      approvalGranted: false,
    })
    await expect(
      db.knowledgeChangeProposal.findFirstOrThrow({
        where: { id: keepProposal.id, tenantId, venueId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'REJECTED' })
    await expect(
      db.semanticConflictResolution.count({
        where: { tenantId, venueId, replacementProposalId: { not: null } },
      }),
    ).resolves.toBe(1)

    const final = await Promise.all([
      db.agentQuestion.count({ where: { tenantId, venueId } }),
      db.agentQuestionOperation.count({ where: { tenantId, venueId } }),
      db.semanticConflictResolution.count({ where: { tenantId, venueId } }),
      db.knowledgeProposalUniversalContentHandoff.count({ where: { tenantId, venueId } }),
      db.contentModuleIdentity.count({ where: { tenantId, venueId } }),
      db.contentModuleRevision.count({ where: { tenantId, venueId } }),
      db.contentModulePublication.count({ where: { tenantId, venueId } }),
      db.venueKnowledgeEntry.findFirstOrThrow({
        where: { id: entryId, tenantId, venueId },
        select: { title: true, category: true, content: true, isEnabled: true },
      }),
      db.semanticConflictResolution.findFirstOrThrow({
        where: { id: resolution.resolutionId, tenantId, venueId },
        select: { answerHash: true, replacementProposalId: true, createdAt: true },
      }),
    ])
    expect(final.slice(0, 7)).toEqual([2, 2, 2, 0, 0, 0, 0])
    expect(final[7]).toEqual(canonical)
    expect(final[8]).toMatchObject({
      answerHash: hashSemanticConflictAnswer(answer),
      replacementProposalId: replacement.id,
      createdAt: expect.any(Date),
    })
    await expect(
      db.$executeRaw`UPDATE semantic_conflict_resolutions
        SET resolution_note = 'tampered'
        WHERE id = ${resolution.resolutionId}::uuid
          AND tenant_id = ${tenantId}
          AND venue_id = ${venueId}`,
    ).rejects.toBeTruthy()
    await expect(
      db.$executeRaw`DELETE FROM semantic_conflict_resolutions
        WHERE id = ${resolution.resolutionId}::uuid
          AND tenant_id = ${tenantId}
          AND venue_id = ${venueId}`,
    ).rejects.toBeTruthy()
    await expect(
      db.semanticConflictResolution.findFirst({
        where: { id: resolution.resolutionId, tenantId, venueId },
        select: { id: true },
      }),
    ).resolves.toEqual({ id: resolution.resolutionId })

    // Draft creation is a later explicit action, after the resolution's zero-effect assertions.
    const preparedAdoption = await caller.prepareLegacyKnowledgeAdoptionDraft({
      tenantId,
      venueId,
      proposalId: replacement.id,
      expectedUpdatedAt: approvedReplacement.updatedAt,
      relation: 'CORRECTS',
      desired: replacementDesired,
    })
    const adoptionInput = {
      ...preparedAdoption,
      draft: {
        audience: 'PUBLIC' as const,
        evidence: [],
        payload: {
          kind: 'POLICY' as const,
          title: replacementDesired.title,
          rule: replacementDesired.content,
          appliesTo: [],
        },
      },
    }
    const adoption = await caller.createSupportLegacyKnowledgeAdoptionDraft(adoptionInput)
    const adoptionReplay = await caller.createSupportLegacyKnowledgeAdoptionDraft(adoptionInput)
    expect(adoption).toMatchObject({ requiresExplicitPublication: true, autoPublished: false })
    expect(adoptionReplay).toMatchObject({ revisionId: adoption.revisionId, replayed: true })
    // The adoption already contains this proposal's approved wording. A second route
    // must not append another revision, regardless of the adoption's publication state.
    await expect(
      caller.createSupportSemanticUniversalContentDraft({
        tenantId,
        venueId,
        proposalId: replacement.id,
        expectedProposalUpdatedAt: approvedReplacement.updatedAt.toISOString(),
        expectedPreviewHash: preparedAdoption.expectedPreviewHash,
        relation: 'CORRECTS',
        desired: replacementDesired,
        draft: adoptionInput.draft,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This proposal already produced an adoption draft; review that revision.',
    })
    const retainedEvidence = await db.contentModuleEvidence.findMany({
      where: { tenantId, venueId, revisionId: adoption.revisionId },
      select: { sourceId: true, locator: true, excerptHash: true },
    })
    expect(retainedEvidence).toEqual([
      {
        sourceId: `support-message:${fixtureRows[0]!.messageId}`,
        locator: `support-request:${fixtureRows[0]!.requestId}`,
        excerptHash: createHash('sha256').update(conflicting.content).digest('hex'),
      },
    ])
    expect(await db.contentModuleRevision.count({ where: { tenantId, venueId } })).toBe(1)
    expect(await db.contentModulePublication.count({ where: { tenantId, venueId } })).toBe(0)
    expect(await db.legacyKnowledgeAdoptionActivation.count({ where: { tenantId, venueId } })).toBe(
      0,
    )
    expect(
      await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { id: entryId, tenantId, venueId },
        select: { content: true },
      }),
    ).toEqual({ content: canonical.content })
  })
})
