import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  claimGuestChatTurnAction,
  db,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  recordConversationLearningCandidate,
  reserveGuestChatTurnAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminConversationLearningRouter } from './conversation-learning'
import { adminEvaluationConversationCasesRouter } from './evaluation-conversation-cases'

const enabled =
  process.env.RUN_NATIVE_REJECTED_LEARNING_EVALUATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_rejected_learning_[a-f0-9]{12}$/.test(process.env.DATABASE_URL ?? '')

const app = router({
  admin: mergeRouters(adminConversationLearningRouter, adminEvaluationConversationCasesRouter),
})

function context(userId: string): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId, activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

describe.skipIf(!enabled)('rejected learning candidate evaluation durable native fixture', () => {
  afterAll(async () => db.$disconnect())

  it('turns a reviewed public rejection into one sanitized revision-bound evaluation case', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-rejected-learning-${suffix}`
    const venueId = `venue-rejected-learning-${suffix}`
    const siblingVenueId = `venue-rejected-learning-sibling-${suffix}`
    const adminId = `admin-rejected-learning-${suffix}`
    const rawVisitorText = 'The vault code is CANDIDATE-RAW-SECRET-DO-NOT-COPY.'
    const reviewerFeedback =
      'This unverified visitor statement must not be treated as venue knowledge.'

    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Rejected learning fixture', slug: tenantId },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Rejected learning venue', slug: venueId },
      })
      await db.venue.create({
        data: {
          id: siblingVenueId,
          tenantId,
          name: 'Rejected learning sibling venue',
          slug: siblingVenueId,
        },
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
          assistantResponse: 'Thank you. Please check with venue staff for verified details.',
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

    const sourceTurn = await completedTurn(rawVisitorText)
    const canonicalKnowledgeBefore = await db.venueKnowledgeEntry.count({
      where: { tenantId, venueId },
    })
    const candidate = await recordConversationLearningCandidate({
      tenantId,
      venueId,
      sessionId: sourceTurn.sessionId,
      guestChatTurnId: sourceTurn.guestChatTurnId,
      userMessageId: sourceTurn.userMessageId,
      source: 'PUBLIC',
      summary: 'Visitor supplied an unverified access detail.',
      classifier: { kind: 'FACTUAL_ADDITION', version: 'rejected-learning-evaluation-native-v1' },
      hedged: true,
    })
    expect(candidate.replayed).toBe(false)
    const noFeedbackTurn = await completedTurn('A separate unreviewed candidate remains unlisted.')
    await recordConversationLearningCandidate({
      tenantId,
      venueId,
      sessionId: noFeedbackTurn.sessionId,
      guestChatTurnId: noFeedbackTurn.guestChatTurnId,
      userMessageId: noFeedbackTurn.userMessageId,
      source: 'PUBLIC',
      summary: 'Unreviewed candidate without reviewer feedback.',
      classifier: { kind: 'FACTUAL_ADDITION', version: 'rejected-learning-evaluation-native-v1' },
      hedged: true,
    })

    const caller = app.createCaller(context(adminId)).admin
    const reviewed = await caller.reviewConversationLearningCandidate({
      tenantId,
      venueId,
      operationId: randomUUID(),
      insightId: candidate.insight.id,
      expectedRevision: candidate.insight.candidateRevision,
      action: 'REJECT',
      reviewerFeedback,
    })
    expect(reviewed).toMatchObject({
      replayed: false,
      canonicalKnowledgeChanged: false,
      insight: {
        id: candidate.insight.id,
        reviewStatus: 'DISMISSED',
        candidateRevision: candidate.insight.candidateRevision + 1,
      },
    })

    const rejected = await caller.listRejectedConversationCandidates({ tenantId, venueId })
    expect(rejected).toEqual([
      expect.objectContaining({
        id: candidate.insight.id,
        category: 'CONTENT_UPDATE_CANDIDATE',
        summary: 'Visitor supplied an unverified access detail.',
        reviewerFeedback,
        candidateRevision: reviewed.insight.candidateRevision,
        reviewedAt: expect.any(Date),
      }),
    ])
    await expect(
      caller.listRejectedConversationCandidates({ tenantId, venueId: siblingVenueId }),
    ).resolves.toEqual([])

    const prepareInput = {
      tenantId,
      venueId,
      insightId: candidate.insight.id,
      expectedCandidateRevision: reviewed.insight.candidateRevision,
      sanitizedQuestion: 'How should a guide respond to an unverified visitor report?',
      expectation: 'UNKNOWN_ANSWER' as const,
      acceptablePhrases: ['check with venue staff'],
      forbiddenPhrases: ['confirm the report'],
      maxWords: 60,
      sanitizationConfirmed: true as const,
    }
    const prepared = await caller.prepareConversationEvaluationCase(prepareInput)
    expect(prepared).toMatchObject({
      caseKey: `conversation-insight-${candidate.insight.id}`,
      revision: 1,
      category: 'unknown-answer',
      sourceInsightId: candidate.insight.id,
      replayed: false,
    })

    const persisted = await db.evalCase.findFirstOrThrow({
      where: { id: prepared.id, tenantId, venueId },
      select: { revision: true, sourceType: true, sourceRef: true, caseSnapshot: true },
    })
    expect(persisted).toMatchObject({
      revision: 1,
      sourceType: 'REVIEWED_CONVERSATION_INSIGHT',
      sourceRef: `conversation-insight:${candidate.insight.id}:turn:${sourceTurn.guestChatTurnId}:candidate-revision:${reviewed.insight.candidateRevision}`,
    })
    const snapshot = JSON.stringify(persisted.caseSnapshot)
    expect(snapshot).toContain(prepareInput.sanitizedQuestion)
    expect(snapshot).not.toContain(rawVisitorText)
    expect(snapshot).not.toContain(reviewerFeedback)

    await expect(
      caller.prepareConversationEvaluationCase({
        ...prepareInput,
        expectedCandidateRevision: reviewed.insight.candidateRevision - 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.prepareConversationEvaluationCase({ ...prepareInput, venueId: siblingVenueId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await db.evalCase.count({ where: { tenantId, venueId } })).toBe(1)

    await expect(caller.prepareConversationEvaluationCase(prepareInput)).resolves.toMatchObject({
      id: prepared.id,
      revision: prepared.revision,
      replayed: true,
    })
    const insightAfter = await db.conversationInsight.findFirstOrThrow({
      where: { id: candidate.insight.id, tenantId, venueId },
      select: { reviewStatus: true, candidateRevision: true, reviewerFeedback: true },
    })
    expect(insightAfter).toEqual({
      reviewStatus: 'DISMISSED',
      candidateRevision: reviewed.insight.candidateRevision,
      reviewerFeedback,
    })
    expect(await db.evalCase.count({ where: { tenantId, venueId } })).toBe(1)
    expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(
      canonicalKnowledgeBefore,
    )
  })
})
