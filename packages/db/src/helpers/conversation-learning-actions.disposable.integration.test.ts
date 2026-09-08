import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  claimGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  reserveGuestChatTurnAction,
} from './guest-chat-turn-actions'
import {
  getConversationLearningPolicy,
  recordConversationLearningCandidate,
  reviewConversationLearningCandidate,
  updateConversationLearningPolicy,
} from './conversation-learning-actions'

const enabled =
  process.env.RUN_NATIVE_CONVERSATION_LEARNING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_native_guest_read_[a-f0-9]{12}$/.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('conversation learning durable native fixture', () => {
  afterAll(async () => db.$disconnect())

  it('persists only eligible scoped evidence and reviews it without canonical mutation', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-learning-${suffix}`,
      venueId = `venue-learning-${suffix}`,
      ownerId = `owner-learning-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Learning fixture', slug: tenantId } })
      await db.user.create({ data: { id: ownerId, email: `${ownerId}@example.test` } })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerId, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Learning venue', slug: venueId },
      })
    })
    const request = {
      tenantId,
      venueId,
      anonymousToken: randomUUID(),
      requestId: randomUUID(),
      visitorId: null,
      message: 'The Rose Cottage has a new label.',
      language: 'English',
      lat: null,
      lng: null,
      retainLocation: false,
      experienceScope: 'PUBLIC' as const,
      visitContext: {
        visitedPlaceIds: ['rose-cottage'],
        interests: ['miniature architecture'],
        remainingMinutes: 25,
      },
    }
    const reservation = await reserveGuestChatTurnAction({ request })
    if (reservation.state !== 'RESERVED') throw new Error('turn did not reserve')
    const claim = {
      tenantId,
      venueId,
      anonymousToken: request.anonymousToken,
      requestId: request.requestId,
      turnId: reservation.turnId,
      claimId: randomUUID(),
    }
    await claimGuestChatTurnAction({ claim })
    for (const kind of ['QUERY_EMBEDDING', 'RESPONSE_GENERATION'] as const) {
      await markGuestChatProviderDispatchedAction({ operation: { ...claim, kind } })
      await observeGuestChatProviderOperationAction({
        operation: { ...claim, kind, outcomeCode: 'SYNTHETIC_PROVIDER_DARK' },
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
    const replayedReservation = await reserveGuestChatTurnAction({ request })
    expect(replayedReservation).toMatchObject({
      state: 'COMPLETE',
      turnId: reservation.turnId,
      sessionId: finalized.sessionId,
      replayed: true,
    })
    await expect(
      reserveGuestChatTurnAction({
        request: {
          ...request,
          visitContext: {
            ...request.visitContext,
            interests: ['railroad history'],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      finalizeGuestChatTurnAction({
        input: {
          ...request,
          visitContext: {
            ...request.visitContext,
            interests: ['railroad history'],
          },
          turnId: reservation.turnId,
          claimId: claim.claimId,
          assistantResponse: 'Thank you.',
          replayMetadata: { places: [], citations: [] },
          fallbackCode: null,
          nextPending: { kind: 'NONE' },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const turnId = reservation.turnId
    const sessionId = finalized.sessionId
    const turn = await db.guestChatTurn.findFirstOrThrow({
      where: { id: turnId, tenantId, venueId, sessionId },
      select: { userMessageId: true },
    })
    if (!turn.userMessageId) throw new Error('turn has no user message')
    const candidate = await recordConversationLearningCandidate({
      tenantId,
      venueId,
      sessionId,
      guestChatTurnId: turnId,
      userMessageId: turn.userMessageId,
      source: 'PUBLIC',
      summary: 'Possible Rose Cottage label update.',
      classifier: { kind: 'FACTUAL_ADDITION', version: 'v1' },
      hedged: true,
    })
    expect(candidate.replayed).toBe(false)
    expect(
      (
        await recordConversationLearningCandidate({
          tenantId,
          venueId,
          sessionId,
          guestChatTurnId: turnId,
          userMessageId: turn.userMessageId,
          source: 'PUBLIC',
          summary: 'Possible Rose Cottage label update.',
          classifier: { kind: 'FACTUAL_ADDITION', version: 'v1' },
          hedged: true,
        })
      ).replayed,
    ).toBe(true)
    const policy = await getConversationLearningPolicy({ tenantId, venueId })
    const changed = await updateConversationLearningPolicy({
      tenantId,
      venueId,
      policy: 'DISABLED',
      expectedUpdatedAt: policy.updatedAt,
      operationId: randomUUID(),
      actor: { type: 'HUMAN', id: ownerId, role: 'OWNER' },
    })
    await expect(
      recordConversationLearningCandidate({
        tenantId,
        venueId,
        sessionId,
        guestChatTurnId: turnId,
        userMessageId: turn.userMessageId,
        source: 'PUBLIC',
        summary: 'Blocked after disable.',
        classifier: { kind: 'FACTUAL_ADDITION', version: 'v2' },
        hedged: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      updateConversationLearningPolicy({
        tenantId,
        venueId,
        policy: 'VISITOR_AND_EMPLOYEE',
        expectedUpdatedAt: policy.updatedAt,
        operationId: randomUUID(),
        actor: { type: 'HUMAN', id: ownerId, role: 'OWNER' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const knowledgeBefore = await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })
    const reviewed = await reviewConversationLearningCandidate({
      operationId: randomUUID(),
      tenantId,
      venueId,
      insightId: candidate.insight.id,
      expectedRevision: candidate.insight.candidateRevision,
      action: 'ACCEPT_FOR_PROPOSAL',
      reviewerFeedback: 'Needs a source-backed proposal.',
      actor: { type: 'HUMAN', id: ownerId, role: 'OWNER' },
    })
    expect(reviewed).toMatchObject({
      replayed: false,
      canonicalKnowledgeChanged: false,
      insight: { reviewStatus: 'ACKNOWLEDGED' },
    })
    expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(
      knowledgeBefore,
    )

    async function completedTurn(
      tenantId: string,
      venueId: string,
      experienceScope: 'PUBLIC' | 'SECOND_LAYER',
    ) {
      const request = {
        tenantId,
        venueId,
        anonymousToken: randomUUID(),
        requestId: randomUUID(),
        visitorId: null,
        message: 'Case 12 is on the second floor.',
        language: 'English',
        lat: null,
        lng: null,
        retainLocation: false,
        experienceScope,
      }
      const reservation = await reserveGuestChatTurnAction({ request })
      const claim = {
        tenantId,
        venueId,
        anonymousToken: request.anonymousToken,
        requestId: request.requestId,
        turnId: reservation.turnId,
        claimId: randomUUID(),
      }
      const claimed = await claimGuestChatTurnAction({ claim })
      if (claimed.state !== 'GENERATING') throw new Error('Fixture turn not claimed')
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
      if (!turn.userMessageId) throw new Error('Fixture source message missing')
      return {
        sessionId: finalized.sessionId,
        guestChatTurnId: reservation.turnId,
        userMessageId: turn.userMessageId,
      }
    }
    expect(changed.policy).toBe('DISABLED')

    const policyCommand = {
      tenantId,
      venueId,
      operationId: randomUUID(),
      policy: 'EMPLOYEE_ONLY' as const,
      expectedUpdatedAt: changed.updatedAt,
      actor: { type: 'HUMAN' as const, id: ownerId, role: 'OWNER' as const },
    }
    const policyResults = await Promise.all([
      updateConversationLearningPolicy(policyCommand),
      updateConversationLearningPolicy(policyCommand),
    ])
    expect(policyResults[0].updatedAt).toEqual(policyResults[1].updatedAt)
    await expect(
      updateConversationLearningPolicy({ ...policyCommand, policy: 'DISABLED' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const employeeTurn = await completedTurn(tenantId, venueId, 'SECOND_LAYER')
    const employeeCommand = {
      tenantId,
      venueId,
      ...employeeTurn,
      source: 'SECOND_LAYER' as const,
      authenticatedActorRef: ownerId,
      summary: 'A conversation message may contain a location or wayfinding fact.',
      classifier: { kind: 'LOCATION', version: 'conversation-learning-en-v1' },
      hedged: false,
    }
    const captures = await Promise.all([
      recordConversationLearningCandidate(employeeCommand),
      recordConversationLearningCandidate(employeeCommand),
    ])
    expect(captures[0].insight.id).toBe(captures[1].insight.id)
    expect(captures.map((value) => value.replayed).sort()).toEqual([false, true])
    await expect(
      recordConversationLearningCandidate({
        ...employeeCommand,
        authenticatedActorRef: 'not-a-member',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      recordConversationLearningCandidate({
        ...employeeCommand,
        userMessageId: turn.userMessageId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      recordConversationLearningCandidate({ ...employeeCommand, source: 'PUBLIC' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      recordConversationLearningCandidate({ ...employeeCommand, venueId: 'sibling-venue' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const reviewCommand = {
      tenantId,
      venueId,
      operationId: randomUUID(),
      insightId: captures[0].insight.id,
      expectedRevision: 0,
      action: 'EDIT' as const,
      summary: 'Case 12 is reported on the second floor; verify the floor label.',
      reviewerFeedback: 'Compare the supplied statement with the current floor plan.',
      actor: policyCommand.actor,
    }
    const edits = await Promise.all([
      reviewConversationLearningCandidate(reviewCommand),
      reviewConversationLearningCandidate(reviewCommand),
    ])
    expect(edits.map((value) => value.replayed).sort()).toEqual([false, true])
    expect(edits[0].insight.candidateRevision).toBe(1)
    const decisions = await Promise.allSettled([
      reviewConversationLearningCandidate({
        ...reviewCommand,
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'ACCEPT_FOR_PROPOSAL',
      }),
      reviewConversationLearningCandidate({
        ...reviewCommand,
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'REJECT',
      }),
    ])
    expect(decisions.filter((value) => value.status === 'fulfilled')).toHaveLength(1)
    expect(decisions.filter((value) => value.status === 'rejected')).toHaveLength(1)
    expect(
      (await reviewConversationLearningCandidate(reviewCommand)).insight.candidateRevision,
    ).toBe(1)
    await expect(
      reviewConversationLearningCandidate({
        ...reviewCommand,
        reviewerFeedback: 'Different intent',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await db.tenantMembership.updateMany({
      where: { tenantId, userId: ownerId },
      data: { status: 'REMOVED' },
    })
    await expect(recordConversationLearningCandidate(employeeCommand)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await db.venueKnowledgeEntry.count({ where: { tenantId, venueId } })).toBe(
      knowledgeBefore,
    )
  })
})
