import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { buildGuestAnswerEvidenceBundle } from '@pathfinder/contracts/guest-answer-attribution-node'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordHumanReviewedGuestAnswerAttributionAction } from './guest-answer-attribution-actions'
import {
  claimGuestChatTurnAction,
  finalizeGuestChatTurnAction,
  markGuestChatProviderDispatchedAction,
  observeGuestChatProviderOperationAction,
  reserveGuestChatTurnAction,
} from './guest-chat-turn-actions'

const enabled =
  process.env.RUN_GUEST_ANSWER_ATTRIBUTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_answer_attribution_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('guest answer attribution disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('binds exact answer/source evidence, replay, audit, tenancy, and append-only history', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-attribution-${suffix}`
      const otherTenantId = `tenant-attribution-other-${suffix}`
      const venueId = `venue-attribution-${suffix}`
      const sessionId = `session-attribution-${suffix}`
      const answer = 'The museum is open today.'
      const evidence = buildGuestAnswerEvidenceBundle({
        assistantResponse: answer,
        staticSystemPrompt: 'You are the venue guide.',
        dynamicSystemPrompt: 'The museum is open today.',
        routeConfigurationVersion: 'integration-route-v1',
        sources: [
          {
            sourceId: `venue:${venueId}`,
            kind: 'VENUE_PROFILE',
            label: 'Synthetic Museum',
            snapshot: { name: 'Synthetic Museum', hours: 'Open today' },
          },
        ],
      })

      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Synthetic attribution tenant', slug: tenantId },
          { id: otherTenantId, name: 'Synthetic other tenant', slug: otherTenantId },
        ],
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic Museum', slug: venueId },
      })
      await db.visitorSession.create({
        data: {
          id: sessionId,
          tenantId,
          venueId,
          anonymousToken: randomUUID(),
          experienceScope: 'PUBLIC',
        },
      })
      const turnRequest = {
        tenantId,
        venueId,
        anonymousToken: (await db.visitorSession.findUniqueOrThrow({ where: { id: sessionId } }))
          .anonymousToken,
        requestId: randomUUID(),
        visitorId: null,
        message: 'Are you open today?',
        language: 'English',
        lat: null,
        lng: null,
        retainLocation: false,
        experienceScope: 'PUBLIC' as const,
      }
      const reservation = await reserveGuestChatTurnAction({ request: turnRequest })
      if (reservation.state !== 'RESERVED') throw new Error('Expected a fresh chat reservation')
      const claimId = randomUUID()
      const claim = {
        tenantId,
        venueId,
        anonymousToken: turnRequest.anonymousToken,
        requestId: turnRequest.requestId,
        turnId: reservation.turnId,
        claimId,
      }
      await claimGuestChatTurnAction({
        claim,
      })
      await markGuestChatProviderDispatchedAction({
        operation: {
          ...claim,
          kind: 'QUERY_EMBEDDING',
        },
      })
      await observeGuestChatProviderOperationAction({
        operation: {
          ...claim,
          kind: 'QUERY_EMBEDDING',
          outcomeCode: 'SYNTHETIC_PROVIDER_DARK',
        },
      })
      await markGuestChatProviderDispatchedAction({
        operation: {
          ...claim,
          kind: 'RESPONSE_GENERATION',
        },
      })
      await observeGuestChatProviderOperationAction({
        operation: {
          ...claim,
          kind: 'RESPONSE_GENERATION',
          outcomeCode: 'SYNTHETIC_PROVIDER_DARK',
        },
      })
      const finalized = await finalizeGuestChatTurnAction({
        input: {
          ...turnRequest,
          turnId: reservation.turnId,
          claimId,
          assistantResponse: answer,
          replayMetadata: { places: [], citations: [], answerEvidence: evidence },
          fallbackCode: null,
          nextPending: { kind: 'NONE' },
        },
      })
      const turnId = finalized.turnId

      const request = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        guestChatTurnId: turnId,
        evaluator: {
          provider: 'human-review',
          model: 'integration-admin',
          configurationVersion: 'review-form-v1',
          promptVersion: 'claim-rubric-v1',
        },
        claims: [
          {
            start: 0,
            end: answer.length,
            text: answer,
            support: 'SUPPORTED' as const,
            sourceIds: [`venue:${venueId}`],
            rationale: 'The frozen venue profile supports the claim.',
          },
        ],
        actor: {
          type: 'HUMAN' as const,
          id: 'integration-admin',
          role: 'PLATFORM_ADMIN' as const,
        },
      }
      const first = await recordHumanReviewedGuestAnswerAttributionAction(request)
      expect(first).toMatchObject({
        replayed: false,
        attribution: { claimCount: 1, supportedCount: 1 },
      })
      expect(String(first.attribution.supportRate)).toBe('1')
      await expect(recordHumanReviewedGuestAnswerAttributionAction(request)).resolves.toMatchObject(
        { replayed: true, attribution: { id: first.attribution.id } },
      )
      await expect(
        recordHumanReviewedGuestAnswerAttributionAction({
          ...request,
          operationId: randomUUID(),
          tenantId: otherTenantId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      expect(
        await db.auditLog.count({
          where: {
            action: 'guest-answer-attribution.recorded',
            targetId: first.attribution.id,
          },
        }),
      ).toBe(1)
      await expect(
        db.$executeRaw`UPDATE "guest_answer_attributions" SET "actor_id" = 'mutated' WHERE "id" = ${first.attribution.id}::uuid`,
      ).rejects.toThrow(/append-only/iu)
      await expect(
        db.$executeRaw`DELETE FROM "guest_answer_attributions" WHERE "id" = ${first.attribution.id}::uuid`,
      ).rejects.toThrow(/append-only/iu)
      expect(await db.guestAnswerAttribution.count({ where: { tenantId, venueId } })).toBe(1)
      expect(await db.operationalEvent.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.knowledgeChangeProposal.count({ where: { tenantId, venueId } })).toBe(0)
    })
  })
})
