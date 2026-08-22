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
  listConversationKnowledgeGaps,
  proposeKnowledgeCorrectionAction,
} from './knowledge-correction-actions'

const enabled =
  process.env.RUN_KNOWLEDGE_CORRECTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('knowledge correction disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('turns one flagged public answer into one review-only, evidence-linked proposal', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID()
      const tenantId = `tenant-knowledge-correction-${suffix}`
      const venueId = `venue-knowledge-correction-${suffix}`
      const insightId = randomUUID()
      const operationId = randomUUID()
      const anonymousToken = randomUUID()
      const requestId = randomUUID()
      const claimId = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Disposable correction tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Disposable correction venue', slug: venueId },
      })
      const request = {
        tenantId,
        venueId,
        anonymousToken,
        requestId,
        visitorId: null,
        message: 'Where is the accessible entrance?',
        language: 'en',
        lat: null,
        lng: null,
        retainLocation: false,
        experienceScope: 'PUBLIC' as const,
      }
      const reservation = await reserveGuestChatTurnAction({ request })
      const claim = await claimGuestChatTurnAction({
        claim: {
          tenantId,
          venueId,
          anonymousToken,
          requestId,
          turnId: reservation.turnId,
          claimId,
        },
      })
      if (claim.state !== 'GENERATING') throw new Error('Disposable turn was not claimed.')
      for (const operation of claim.providerOperations) {
        const operationScope = {
          tenantId,
          venueId,
          anonymousToken,
          requestId,
          turnId: reservation.turnId,
          claimId,
          kind: operation.kind,
        }
        await markGuestChatProviderDispatchedAction({ operation: operationScope })
        await observeGuestChatProviderOperationAction({
          operation: { ...operationScope, outcomeCode: 'SUCCESS' },
        })
      }
      await finalizeGuestChatTurnAction({
        input: {
          ...request,
          turnId: reservation.turnId,
          claimId,
          assistantResponse: 'I do not have verified entrance information.',
          replayMetadata: { places: [] },
          fallbackCode: 'NO_RELEVANT_CONTEXT',
          nextPending: { kind: 'NONE' },
        },
      })
      const turn = await db.guestChatTurn.findUniqueOrThrow({
        where: { id: reservation.turnId },
        select: { userMessageId: true, assistantMessageId: true },
      })
      if (!turn.userMessageId || !turn.assistantMessageId) {
        throw new Error('Finalized disposable turn did not retain exact message evidence.')
      }
      const userMessageId = turn.userMessageId
      const assistantMessageId = turn.assistantMessageId
      await db.conversationInsight.create({
        data: {
          id: insightId,
          tenantId,
          venueId,
          sessionId: reservation.sessionId,
          guestChatTurnId: reservation.turnId,
          category: 'KNOWLEDGE_GAP',
          confidence: 0.77,
          severity: 'HIGH',
          summary: 'The answer lacked verified accessibility information.',
          suggestedAction: 'Prepare a source-backed correction for review.',
          evidenceMessageIds: [userMessageId, assistantMessageId],
          messageSequenceStart: 0,
          messageSequenceEnd: 1,
          capability: 'visitor-answer-analysis',
          provider: 'deterministic',
          model: 'fixture',
          analyzerVersion: 'integration-v1',
        },
      })

      await expect(
        listConversationKnowledgeGaps({ tenantId, venueId, limit: 10 }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: insightId,
          visitorQuestion: 'Where is the accessible entrance?',
          assistantAnswer: 'I do not have verified entrance information.',
          evidenceMessageIds: [userMessageId, assistantMessageId],
        }),
      ])

      const input = {
        operationId,
        tenantId,
        venueId,
        conversationInsightId: insightId,
        correctionKind: 'RETRIEVAL_CORRECTION' as const,
        aiInference: 'The response should retrieve a verified accessibility source.',
        proposedChange: 'Add the verified accessible entrance after venue review.',
        reason: 'The flagged public turn contains exact question and answer evidence.',
        confidence: 0.84,
        actor: {
          type: 'AGENT' as const,
          actorId: 'agent-knowledge-review',
          role: 'AGENT' as const,
          agentIdentityId: 'agent-knowledge-review',
          agentRunId: 'run-knowledge-review',
          workerId: 'worker-knowledge-review',
          credentialId: 'credential-knowledge-review',
          capability: 'knowledge:draft',
          idempotencyKey: operationId,
          modelProvider: 'provider-dark',
          modelName: 'deterministic-fixture',
        },
      }

      const created = await proposeKnowledgeCorrectionAction(input)
      expect(created).toMatchObject({
        replayed: false,
        proposal: { id: operationId, status: 'PENDING_REVIEW' },
      })
      await expect(proposeKnowledgeCorrectionAction(input)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(
        proposeKnowledgeCorrectionAction({
          ...input,
          operationId: randomUUID(),
          actor: { ...input.actor, idempotencyKey: randomUUID() },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const [proposal, insight, canonicalCount, audit] = await Promise.all([
        db.knowledgeChangeProposal.findUniqueOrThrow({ where: { id: operationId } }),
        db.conversationInsight.findUniqueOrThrow({ where: { id: insightId } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        db.auditLog.findFirstOrThrow({
          where: {
            tenantId,
            action: 'knowledge-proposal.agent-prepared',
            targetId: operationId,
          },
        }),
      ])
      expect(proposal).toMatchObject({
        status: 'PENDING_REVIEW',
        createdByType: 'AGENT',
        evidenceMessageIds: [userMessageId, assistantMessageId],
      })
      expect(insight.reviewStatus).toBe('ACTIONED')
      expect(canonicalCount).toBe(0)
      expect(audit).toMatchObject({
        agentRunId: 'run-knowledge-review',
        credentialId: 'credential-knowledge-review',
        capability: 'knowledge:draft',
      })
    })
  })
})
