import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  claimGuestChatTurnAction,
  createOperationalUpdateAction,
  db,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  recordConversationLearningCandidate,
  reserveGuestChatTurnAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mediaIntakeHash } from '../../lib/media-intake-snapshot'
import { createMediaTemporalReviewReceipt } from '../../lib/media-temporal-review-service'
import { semanticOperationalUpdateDraftFinalizer } from '../../lib/semantic-operational-update-finalizer'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'

import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminConversationLearningRouter } from './conversation-learning'
import { adminKnowledgeProposalsRouter } from './knowledge-proposals'

const enabled =
  process.env.RUN_NATIVE_KNOWLEDGE_PROPOSAL_LEARNING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_native_guest_read_[a-f0-9]{12}$/.test(process.env.DATABASE_URL ?? '')

const app = router({
  admin: mergeRouters(adminConversationLearningRouter, adminKnowledgeProposalsRouter),
})

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

describe.skipIf(!enabled)('knowledge proposal learning durable native fixture', () => {
  afterAll(async () => db.$disconnect())

  it('records a candidate, acknowledges it, and creates only a scoped draft proposal', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-proposal-learning-${suffix}`
    const venueId = `venue-proposal-learning-${suffix}`
    const adminId = `admin-proposal-learning-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Proposal learning fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Proposal learning venue', slug: venueId },
      })
    })

    async function completedTurn(message: string) {
      const request = {
        tenantId,
        venueId,
        anonymousToken: randomUUID(),
        requestId: randomUUID(),
        visitorId: null,
        message,
        language: 'English',
        lat: null,
        lng: null,
        retainLocation: false,
        experienceScope: 'PUBLIC' as const,
      }
      const reservation = await reserveGuestChatTurnAction({ request })
      if (reservation.state !== 'RESERVED') throw new Error('fixture turn was not reserved')
      const claim = {
        tenantId,
        venueId,
        anonymousToken: request.anonymousToken,
        requestId: request.requestId,
        turnId: reservation.turnId,
        claimId: randomUUID(),
      }
      const claimed = await claimGuestChatTurnAction({ claim })
      if (claimed.state !== 'GENERATING') throw new Error('fixture turn was not claimed')
      for (const operation of claimed.providerOperations) {
        await markGuestChatProviderDispatchedAction({
          operation: { ...claim, kind: operation.kind },
        })
        await observeGuestChatProviderOperationAction({
          operation: { ...claim, kind: operation.kind, outcomeCode: 'SYNTHETIC_PROVIDER_DARK' },
        })
      }
      const finalized = await finalizeGuestChatTurnAction({
        input: {
          ...request,
          turnId: reservation.turnId,
          claimId: claim.claimId,
          assistantResponse: 'Thank you.',
          replayMetadata: { places: [], citations: [] },
          fallbackCode: null,
          nextPending: { kind: 'NONE' },
        },
      })
      const turn = await db.guestChatTurn.findFirstOrThrow({
        where: { id: reservation.turnId, tenantId, venueId, sessionId: finalized.sessionId },
        select: { userMessageId: true },
      })
      if (!turn.userMessageId) throw new Error('fixture source message missing')
      return {
        sessionId: finalized.sessionId,
        guestChatTurnId: reservation.turnId,
        userMessageId: turn.userMessageId,
      }
    }

    const sourceTurn = await completedTurn('A visitor says the cottage label may need an update.')
    const otherSessionTurn = await completedTurn(
      'A separate visitor message must not become this candidate evidence.',
    )
    const knowledgeBefore = await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })
    const candidate = await recordConversationLearningCandidate({
      tenantId,
      venueId,
      sessionId: sourceTurn.sessionId,
      guestChatTurnId: sourceTurn.guestChatTurnId,
      userMessageId: sourceTurn.userMessageId,
      source: 'PUBLIC',
      summary: 'Possible cottage label update.',
      classifier: { kind: 'FACTUAL_ADDITION', version: 'knowledge-proposal-native-v1' },
      hedged: true,
    })
    expect(candidate.replayed).toBe(false)
    expect(
      (
        await recordConversationLearningCandidate({
          tenantId,
          venueId,
          sessionId: sourceTurn.sessionId,
          guestChatTurnId: sourceTurn.guestChatTurnId,
          userMessageId: sourceTurn.userMessageId,
          source: 'PUBLIC',
          summary: 'Possible cottage label update.',
          classifier: { kind: 'FACTUAL_ADDITION', version: 'knowledge-proposal-native-v1' },
          hedged: true,
        })
      ).replayed,
    ).toBe(true)

    const caller = app.createCaller(context(adminId)).admin
    const reviewed = await caller.reviewConversationLearningCandidate({
      tenantId,
      venueId,
      operationId: randomUUID(),
      insightId: candidate.insight.id,
      expectedRevision: candidate.insight.candidateRevision,
      action: 'ACCEPT_FOR_PROPOSAL',
      reviewerFeedback: 'Requires a human-reviewed proposal.',
    })
    expect(reviewed).toMatchObject({
      replayed: false,
      canonicalKnowledgeChanged: false,
      insight: { reviewStatus: 'ACKNOWLEDGED' },
    })

    const proposalInput = {
      operationId: randomUUID(),
      tenantId,
      venueId,
      conversationInsightId: candidate.insight.id,
      proposedChange: 'Review the cottage label against an approved source.',
      reason: 'The visitor statement is an unverified learning candidate.',
      confidence: 0.5,
      evidenceMessageIds: [sourceTurn.userMessageId],
      submitForReview: false,
    }
    await expect(
      caller.createKnowledgeProposal({
        ...proposalInput,
        evidenceMessageIds: [otherSessionTurn.userMessageId],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.createKnowledgeProposal({ ...proposalInput, tenantId: `other-${suffix}` }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const created = await caller.createKnowledgeProposal(proposalInput)
    expect(created).toMatchObject({ status: 'DRAFT', replayed: false })
    await expect(caller.createKnowledgeProposal(proposalInput)).resolves.toMatchObject({
      id: created.id,
      status: 'DRAFT',
      replayed: true,
    })
    await expect(
      caller.createKnowledgeProposal({ ...proposalInput, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const persisted = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { id: created.id, tenantId, venueId, conversationInsightId: candidate.insight.id },
      select: { status: true, sessionId: true, evidenceMessageIds: true },
    })
    expect(persisted).toEqual({
      status: 'DRAFT',
      sessionId: sourceTurn.sessionId,
      evidenceMessageIds: [sourceTurn.userMessageId],
    })
    expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(
      knowledgeBefore,
    )

    const temporalTurn = await completedTurn('The north entrance is closed for maintenance.')
    const temporalCandidate = await recordConversationLearningCandidate({
      tenantId,
      venueId,
      sessionId: temporalTurn.sessionId,
      guestChatTurnId: temporalTurn.guestChatTurnId,
      userMessageId: temporalTurn.userMessageId,
      source: 'PUBLIC',
      summary: 'A visitor reports a temporary north entrance closure.',
      classifier: { kind: 'TEMPORARY_UPDATE', version: 'knowledge-proposal-native-v1' },
      hedged: false,
    })
    const temporalProposal = await caller.createKnowledgeProposal({
      operationId: randomUUID(),
      tenantId,
      venueId,
      conversationInsightId: temporalCandidate.insight.id,
      proposedChange: 'The north entrance is closed for maintenance.',
      reason: 'The visitor report requires a reviewed finite temporal source.',
      confidence: 0,
      evidenceMessageIds: [temporalTurn.userMessageId],
      submitForReview: true,
    })
    const proposalBeforeReview = await db.knowledgeChangeProposal.findUniqueOrThrow({
      where: { id: temporalProposal.id, tenantId, venueId },
      select: { updatedAt: true },
    })
    await caller.reviewKnowledgeProposal({
      operationId: randomUUID(),
      tenantId,
      venueId,
      proposalId: temporalProposal.id,
      expectedUpdatedAt: proposalBeforeReview.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'Approved only when exact reviewed temporal evidence is supplied.',
    })
    const desired = {
      title: 'North entrance closure',
      category: 'TEMPORARY_CLOSURE',
      content: 'The north entrance is closed for maintenance.',
      isEnabled: true,
    }
    const validFrom = '2030-01-01T00:00:00.000Z'
    const validUntil = '2030-01-03T00:00:00.000Z'
    const proposal = await db.knowledgeChangeProposal.findUniqueOrThrow({
      where: { id: temporalProposal.id, tenantId, venueId },
      select: { updatedAt: true },
    })
    const draftInput = {
      tenantId,
      venueId,
      proposalId: temporalProposal.id,
      expectedUpdatedAt: proposal.updatedAt,
      relation: 'NEW_FACT' as const,
      desired,
      validFrom,
      validUntil,
      operationalUpdateType: 'TEMPORARY_CLOSURE' as const,
    }
    await expect(
      caller.createSemanticOperationalUpdateDraft({
        ...draftInput,
        expectedPreviewHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const evidenceLookup = {
      tenantId,
      venueId,
      proposalId: temporalProposal.id,
      expectedUpdatedAt: proposal.updatedAt,
    }
    await expect(
      caller.listKnowledgeProposalTemporalEvidence(evidenceLookup),
    ).resolves.toMatchObject({
      items: [],
      nextCursor: null,
      requiresTemporalEvidence: true,
    })
    const projectId = `temporal-proposal-project-${suffix}`
    const sourceGeneration = randomUUID()
    const uploadAttemptId = randomUUID()
    const item = VenuePackagePayloadV1.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [desired],
    }).knowledgeEntries[0]!
    const observation = {
      kind: 'visible_text' as const,
      statement: desired.content,
      evidenceChannel: 'document_text' as const,
      directness: 'observed' as const,
      confidence: 'confirmed' as const,
      processingMethod: 'text_extraction' as const,
      locator: { type: 'whole_source' as const },
    }
    const findings = ['source-a', 'source-b'].map((sourceId) => ({
      sourceId,
      filename: `${sourceId}.pdf`,
      mediaType: 'DOCUMENT' as const,
      summary: 'Reviewed entrance schedule.',
      uncertainties: [],
      sourceObservations: [observation],
      review: {
        summary: 'Reviewed entrance schedule.',
        uncertainties: [],
        note: 'Reviewed.',
        reviewedBy: adminId,
        reviewedAt: new Date().toISOString(),
      },
    }))
    const project = await db.mediaIngestionProject.create({
      data: {
        id: projectId,
        tenantId,
        venueId,
        name: 'Temporal proposal evidence',
        createdBy: adminId,
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        sourceObjectGeneration: sourceGeneration,
        uploadAttemptId,
        sourceObjectKey: `fixture/${projectId}.zip`,
        draftJson: { schemaVersion: 1, places: [], knowledgeEntries: [item] },
        findings,
      },
    })
    for (const [index, sourceId] of ['source-a', 'source-b'].entries()) {
      await db.mediaIngestionAsset.create({
        data: {
          tenantId,
          sourceId,
          filename: `${sourceId}.pdf`,
          mediaType: 'DOCUMENT',
          objectKey: `fixture/${projectId}.zip#${sourceId}.pdf`,
          bytes: 32n,
          sha256: `${String.fromCharCode(97 + index)}`.repeat(64),
          status: 'COMPLETE',
          analysis: findings[index]!,
          projectId: project.id,
        },
      })
    }
    const itemHash = mediaIntakeHash(item)
    const observationHash = mediaIntakeHash(observation)
    const claims = ['source-a', 'source-b'].map((sourceId, index) => ({
      claimId: `closure-${index}`,
      targetKey: 'north-entrance:status',
      targetItemHash: itemHash,
      claimType: 'TEMPORARY_SCHEDULE' as const,
      value: desired.content,
      valueHash: createHash('sha256').update(desired.content).digest('hex'),
      authority: 'PUBLIC_SOURCE' as const,
      consequential: true,
      effectiveFrom: validFrom,
      effectiveUntil: validUntil,
      source: {
        sourceId,
        sourceSha256: `${String.fromCharCode(97 + index)}`.repeat(64),
        sourceVersion: uploadAttemptId,
        capturedAt: null,
        observationIndex: 0,
        observationSha256: observationHash,
      },
    }))
    const receipt = await createMediaTemporalReviewReceipt({
      client: db,
      actorId: adminId,
      input: {
        tenantId,
        venueId,
        projectId,
        sourceGeneration,
        requestId: randomUUID(),
        expectedUpdatedAt: project.updatedAt.toISOString(),
        rationale: 'Two agreeing reviewed sources support this finite dated closure.',
        claims,
        bindings: [
          { kind: 'knowledge', itemIndex: 0, itemHash, sourceIds: ['source-a', 'source-b'] },
        ],
      },
    })
    const wrongVenueId = `temporal-wrong-venue-${suffix}`
    const wrongProjectId = `temporal-wrong-project-${suffix}`
    const wrongGeneration = randomUUID()
    const wrongUploadAttempt = randomUUID()
    await db.venue.create({
      data: { id: wrongVenueId, tenantId, name: 'Wrong temporal venue', slug: wrongVenueId },
    })
    const wrongProject = await db.mediaIngestionProject.create({
      data: {
        id: wrongProjectId,
        tenantId,
        venueId: wrongVenueId,
        name: 'Wrong scoped temporal evidence',
        createdBy: adminId,
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        sourceObjectGeneration: wrongGeneration,
        uploadAttemptId: wrongUploadAttempt,
        sourceObjectKey: `fixture/${wrongProjectId}.zip`,
        draftJson: { schemaVersion: 1, places: [], knowledgeEntries: [item] },
        findings,
      },
    })
    for (const [index, sourceId] of ['source-a', 'source-b'].entries())
      await db.mediaIngestionAsset.create({
        data: {
          tenantId,
          sourceId,
          filename: `${sourceId}.pdf`,
          mediaType: 'DOCUMENT',
          objectKey: `fixture/${wrongProjectId}.zip#${sourceId}.pdf`,
          bytes: 32n,
          sha256: `${String.fromCharCode(97 + index)}`.repeat(64),
          status: 'COMPLETE',
          analysis: findings[index]!,
          projectId: wrongProject.id,
        },
      })
    const wrongReceipt = await createMediaTemporalReviewReceipt({
      client: db,
      actorId: adminId,
      input: {
        tenantId,
        venueId: wrongVenueId,
        projectId: wrongProjectId,
        sourceGeneration: wrongGeneration,
        requestId: randomUUID(),
        expectedUpdatedAt: wrongProject.updatedAt.toISOString(),
        rationale: 'Wrong-scope receipt for denial coverage.',
        claims: claims.map((claim) => ({
          ...claim,
          source: { ...claim.source, sourceVersion: wrongUploadAttempt },
        })),
        bindings: [
          { kind: 'knowledge', itemIndex: 0, itemHash, sourceIds: ['source-a', 'source-b'] },
        ],
      },
    })
    const temporalEvidence = {
      reviewReceiptId: receipt.receiptId,
      expectedSnapshotHash: receipt.snapshotHash,
      claimId: 'closure-0',
    }
    const options = await caller.listKnowledgeProposalTemporalEvidence(evidenceLookup)
    expect(options.requiresTemporalEvidence).toBe(true)
    expect(options.items).toHaveLength(1)
    expect(options.items[0]).toMatchObject({
      reference: temporalEvidence,
      desired,
      validFrom,
      validUntil,
      sourceNames: ['source-a.pdf', 'source-b.pdf'],
    })
    if (options.nextCursor) {
      await expect(
        caller.listKnowledgeProposalTemporalEvidence({
          ...evidenceLookup,
          cursor: options.nextCursor,
        }),
      ).resolves.toMatchObject({ items: [], nextCursor: null })
    }
    await expect(
      caller.listKnowledgeProposalTemporalEvidence({
        ...evidenceLookup,
        expectedUpdatedAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow()
    await expect(
      caller.listKnowledgeProposalTemporalEvidence({ ...evidenceLookup, venueId: wrongVenueId }),
    ).rejects.toThrow()
    for (const invalid of [
      {
        ...draftInput,
        temporalEvidence: { ...temporalEvidence, expectedSnapshotHash: 'f'.repeat(64) },
      },
      {
        ...draftInput,
        temporalEvidence: {
          ...temporalEvidence,
          reviewReceiptId: wrongReceipt.receiptId,
          expectedSnapshotHash: wrongReceipt.snapshotHash,
        },
      },
      { ...draftInput, temporalEvidence: { ...temporalEvidence, claimId: 'missing-claim' } },
    ])
      await expect(caller.previewSemanticVenueUpdate(invalid)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      })
    await expect(
      caller.previewSemanticVenueUpdate({
        ...draftInput,
        venueId: `wrong-${venueId}`,
        temporalEvidence,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-04T00:00:00.000Z') })
    try {
      await expect(
        caller.previewSemanticVenueUpdate({ ...draftInput, temporalEvidence }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally {
      vi.useRealTimers()
    }
    const preview = await caller.previewSemanticVenueUpdate({ ...draftInput, temporalEvidence })
    expect(preview).toMatchObject({
      classification: 'TEMPORAL',
      authority: 'UNVERIFIED',
      temporalEvidence: { authorityBasis: 'REVIEW_ASSERTED', authorityVerified: false },
    })
    const finalizerCountBefore = await db.operationalUpdate.count({ where: { tenantId, venueId } })
    const rollbackId = randomUUID()
    let finalizerReached = false
    const auditsBefore = await db.auditLog.count({ where: { tenantId } })
    await expect(
      createOperationalUpdateAction(
        {
          tenantId,
          id: rollbackId,
          actor: { type: 'HUMAN', id: adminId, role: 'PLATFORM_ADMIN' },
          schedule: false,
          fields: {
            venueId,
            updateType: preview.operationalUpdateDraft!.updateType,
            severity: preview.operationalUpdateDraft!.severity,
            priority: preview.operationalUpdateDraft!.priority,
            title: preview.operationalUpdateDraft!.title,
            body: preview.operationalUpdateDraft!.body,
            startsAt: new Date(preview.operationalUpdateDraft!.startsAt),
            expiresAt: new Date(preview.operationalUpdateDraft!.expiresAt),
          },
          finalizer: async (args) => {
            expect(
              await args.tx.operationalUpdate.findFirst({
                where: { id: rollbackId, tenantId, venueId },
              }),
            ).not.toBeNull()
            finalizerReached = true
            vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-04T00:00:00.000Z') })
            try {
              return await semanticOperationalUpdateDraftFinalizer({
                actorId: adminId,
                expectedPreviewHash: preview.previewHash,
                previewInput: { ...draftInput, temporalEvidence },
              })(args)
            } finally {
              vi.useRealTimers()
            }
          },
        },
        db,
      ),
    ).rejects.toThrow('expired')
    expect(finalizerReached).toBe(true)
    await expect(db.auditLog.count({ where: { tenantId } })).resolves.toBe(auditsBefore)
    await expect(
      db.contentVersion.count({ where: { tenantId, venueId, entityId: rollbackId } }),
    ).resolves.toBe(0)
    await expect(
      db.knowledgeProposalOperationalUpdateHandoff.count({
        where: { tenantId, venueId, proposalId: temporalProposal.id },
      }),
    ).resolves.toBe(0)
    await expect(db.operationalUpdate.count({ where: { tenantId, venueId } })).resolves.toBe(
      finalizerCountBefore,
    )
    const draftsBeforeExpiry = await db.operationalUpdate.count({ where: { tenantId, venueId } })
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-01-04T00:00:00.000Z') })
    try {
      await expect(
        caller.createSemanticOperationalUpdateDraft({
          ...draftInput,
          expectedPreviewHash: preview.previewHash,
          temporalEvidence,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await expect(db.operationalUpdate.count({ where: { tenantId, venueId } })).resolves.toBe(
        draftsBeforeExpiry,
      )
    } finally {
      vi.useRealTimers()
    }
    const createdTemporalDraft = await caller.createSemanticOperationalUpdateDraft({
      ...draftInput,
      expectedPreviewHash: preview.previewHash,
      temporalEvidence,
    })
    expect(createdTemporalDraft).toMatchObject({
      operationalUpdateStatus: 'DRAFT',
      replayed: false,
    })
    const replayedTemporalDraft = await caller.createSemanticOperationalUpdateDraft({
      ...draftInput,
      expectedPreviewHash: preview.previewHash,
      temporalEvidence,
    })
    expect(replayedTemporalDraft).toMatchObject({
      operationalUpdateId: createdTemporalDraft.operationalUpdateId,
      replayed: true,
    })
    await expect(
      db.operationalUpdate.findUniqueOrThrow({
        where: { id: createdTemporalDraft.operationalUpdateId, tenantId, venueId },
        select: { status: true, isActive: true, body: true, startsAt: true, expiresAt: true },
      }),
    ).resolves.toMatchObject({
      status: 'DRAFT',
      isActive: false,
      body: desired.content,
      startsAt: new Date(validFrom),
      expiresAt: new Date(validUntil),
    })
    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        tenantId,
        action: 'knowledge-proposal.semantic-operational-update-draft-created-and-linked',
        targetId: temporalProposal.id,
      },
      orderBy: { createdAt: 'desc' },
      select: { afterState: true },
    })
    await expect(
      db.knowledgeProposalOperationalUpdateHandoff.count({
        where: { tenantId, venueId, proposalId: temporalProposal.id },
      }),
    ).resolves.toBe(1)
    const retainedReceipt = await db.mediaTemporalReviewReceipt.findUniqueOrThrow({
      where: { id: receipt.receiptId, tenantId, venueId },
      select: { snapshot: true },
    })
    expect(
      (retainedReceipt.snapshot as { sources: Array<{ sha256: string }> }).sources
        .map((source) => source.sha256)
        .sort(),
    ).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(audit.afterState).toMatchObject({
      temporalEvidence: {
        authorityBasis: 'REVIEW_ASSERTED',
        authorityVerified: false,
        reference: temporalEvidence,
        claimHash: mediaIntakeHash(claims[0]),
      },
    })
  })
})
