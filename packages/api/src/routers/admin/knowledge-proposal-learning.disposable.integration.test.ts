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
  })
})
