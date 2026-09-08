import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

const rateLimit = vi.hoisted(() => vi.fn())
vi.mock('./lib/rate-limit', () => ({ checkRateLimit: rateLimit }))

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from './context'
import { router } from './core'
import { visitorHazardDeduplicationKey } from './lib/visitor-signal-candidate'
import { feedbackRouter } from './routers/feedback'

const enabled =
  process.env.RUN_VISITOR_FEEDBACK_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_visitor_feedback_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const caller = router({ feedback: feedbackRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
} satisfies TRPCContext)

async function seedSession(params: {
  tenantId: string
  venueId: string
  experienceScope: 'PUBLIC' | 'SECOND_LAYER'
}) {
  const session = await db.visitorSession.create({
    data: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      anonymousToken: randomUUID(),
      experienceScope: params.experienceScope,
    },
  })
  // This fixture builds the same durable evidence shape that the guest-chat
  // lifecycle guards require: pristine reservation, two provider receipts,
  // GENERATING, observed provider outcomes, paired messages, then COMPLETE.
  // It deliberately does not bypass or relax the production lifecycle schema.
  const turn = await db.guestChatTurn.create({
    data: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      sessionId: session.id,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      turnSequence: 1,
      userMessageSequence: 1,
      assistantMessageSequence: 2,
    },
  })
  const embeddingOperationId = randomUUID()
  const responseOperationId = randomUUID()
  await db.guestChatProviderOperation.createMany({
    data: [
      {
        id: embeddingOperationId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        sessionId: session.id,
        turnId: turn.id,
        kind: 'QUERY_EMBEDDING',
        invocationId: randomUUID(),
      },
      {
        id: responseOperationId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        sessionId: session.id,
        turnId: turn.id,
        kind: 'RESPONSE_GENERATION',
        invocationId: randomUUID(),
      },
    ],
  })
  await db.guestChatTurn.update({ where: { id: turn.id }, data: { status: 'GENERATING' } })
  const dispatchedAt = new Date()
  await db.guestChatProviderOperation.updateMany({
    where: { turnId: turn.id, status: 'RESERVED' },
    data: { status: 'DISPATCHED', dispatchedAt },
  })
  await db.guestChatProviderOperation.updateMany({
    where: { turnId: turn.id, status: 'DISPATCHED' },
    data: {
      status: 'OBSERVED',
      observedAt: new Date(),
      outcomeCode: 'SYNTHETIC_PROVIDER_DARK',
    },
  })
  const user = await db.message.create({
    data: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      sessionId: session.id,
      guestChatTurnId: turn.id,
      sessionSequence: 1,
      turnMessageSequence: 0,
      role: 'user',
      content: 'Is the east entrance open?',
    },
  })
  const assistant = await db.message.create({
    data: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      sessionId: session.id,
      guestChatTurnId: turn.id,
      sessionSequence: 2,
      turnMessageSequence: 1,
      role: 'assistant',
      content: 'The east entrance is open.',
    },
  })
  await db.guestChatTurn.update({
    where: { id: turn.id },
    data: {
      status: 'COMPLETE',
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      replayMetadata: { places: [], citations: [] },
      responseHash: 'b'.repeat(64),
      completedAt: new Date(),
    },
  })
  return { session, turn, assistant }
}

describe.skipIf(!enabled)('visitor feedback hazard escalation on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('records bounded internal hazard groups while preserving the active public attraction', async () => {
    await withTenantIsolationBypass(async () => {
      rateLimit.mockResolvedValue(true)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `visitor-feedback-${suffix}`
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Visitor feedback' } })
      const venue = await db.venue.create({
        data: { tenantId, slug: `visitor-feedback-${suffix}`, name: 'Visitor feedback venue' },
      })
      const attraction = await db.place.create({
        data: {
          tenantId,
          venueId: venue.id,
          name: 'East Garden',
          type: 'ATTRACTION',
          tags: ['garden'],
          isActive: true,
          visibility: 'PUBLIC',
        },
        select: { id: true, name: true, isActive: true, visibility: true },
      })
      const publicSession = await seedSession({
        tenantId,
        venueId: venue.id,
        experienceScope: 'PUBLIC',
      })
      const privateSession = await seedSession({
        tenantId,
        venueId: venue.id,
        experienceScope: 'SECOND_LAYER',
      })
      const siblingPublicSession = await seedSession({
        tenantId,
        venueId: venue.id,
        experienceScope: 'PUBLIC',
      })
      const hazardInput = {
        venueId: venue.id,
        anonymousToken: publicSession.session.anonymousToken,
        messageId: publicSession.assistant.id,
        rating: 'NOT_HELPFUL' as const,
        reason: 'There is broken glass by the east entrance.',
      }

      await expect(caller.feedback.submit(hazardInput)).resolves.toEqual({ ok: true })
      await expect(caller.feedback.submit(hazardInput)).resolves.toEqual({ ok: true })
      const primaryEventKey = visitorHazardDeduplicationKey({
        tenantId,
        venueId: venue.id,
        guestChatTurnId: publicSession.turn.id,
        messageId: publicSession.assistant.id,
      })
      const event = await db.operationalEvent.findUniqueOrThrow({
        where: {
          tenantId_deduplicationKey: {
            tenantId,
            deduplicationKey: primaryEventKey,
          },
        },
        select: {
          id: true,
          severity: true,
          actionRequired: true,
          linkedObjectType: true,
          linkedObjectId: true,
          summary: true,
          occurrenceCount: true,
        },
      })
      const feedback = await db.messageFeedback.findFirstOrThrow({
        where: {
          tenantId,
          venueId: venue.id,
          sessionId: publicSession.session.id,
          messageId: publicSession.assistant.id,
        },
        select: { id: true, rating: true, reason: true },
      })
      expect(event).toMatchObject({
        severity: 'CRITICAL',
        actionRequired: true,
        linkedObjectType: 'MessageFeedback',
        linkedObjectId: feedback.id,
        summary:
          'An unverified visitor feedback report may describe an immediate venue safety hazard.',
        occurrenceCount: 2,
      })
      expect(feedback).toMatchObject({ rating: 'NOT_HELPFUL', reason: hazardInput.reason })

      await expect(
        caller.feedback.submit({ ...hazardInput, reason: 'The East Garden is closed today.' }),
      ).resolves.toEqual({ ok: true })
      await expect(
        caller.feedback.submit({
          ...hazardInput,
          rating: 'HELPFUL',
          reason: 'The answer is correct.',
        }),
      ).resolves.toEqual({ ok: true })
      await expect(
        db.messageFeedback.findUniqueOrThrow({
          where: {
            tenantId_venueId_sessionId_messageId: {
              tenantId,
              venueId: venue.id,
              sessionId: publicSession.session.id,
              messageId: publicSession.assistant.id,
            },
          },
          select: { id: true, rating: true, reason: true },
        }),
      ).resolves.toEqual({ id: feedback.id, rating: 'HELPFUL', reason: 'The answer is correct.' })
      await expect(
        db.operationalEvent.findUniqueOrThrow({
          where: { tenantId_deduplicationKey: { tenantId, deduplicationKey: primaryEventKey } },
          select: {
            linkedObjectId: true,
            occurrenceCount: true,
            summary: true,
            recommendedAction: true,
          },
        }),
      ).resolves.toEqual({
        linkedObjectId: feedback.id,
        occurrenceCount: 2,
        summary:
          'An unverified visitor feedback report may describe an immediate venue safety hazard.',
        recommendedAction:
          'Review the current feedback record and its cited public conversation immediately, then follow the venue safety escalation procedure.',
      })

      await expect(
        caller.feedback.submit({
          ...hazardInput,
          messageId: siblingPublicSession.assistant.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        caller.feedback.submit({
          ...hazardInput,
          anonymousToken: siblingPublicSession.session.anonymousToken,
          messageId: siblingPublicSession.assistant.id,
        }),
      ).resolves.toEqual({ ok: true })
      const siblingEventKey = visitorHazardDeduplicationKey({
        tenantId,
        venueId: venue.id,
        guestChatTurnId: siblingPublicSession.turn.id,
        messageId: siblingPublicSession.assistant.id,
      })

      await expect(
        caller.feedback.submit({
          ...hazardInput,
          anonymousToken: privateSession.session.anonymousToken,
          messageId: privateSession.assistant.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        db.operationalEvent.findUniqueOrThrow({
          where: {
            tenantId_deduplicationKey: {
              tenantId,
              deduplicationKey: primaryEventKey,
            },
          },
          select: { occurrenceCount: true },
        }),
      ).resolves.toEqual({ occurrenceCount: 2 })
      const [siblingEvent, groups, unchangedAttraction, effects] = await Promise.all([
        db.operationalEvent.findUniqueOrThrow({
          where: { tenantId_deduplicationKey: { tenantId, deduplicationKey: siblingEventKey } },
          select: { id: true, occurrenceCount: true },
        }),
        db.operationalEvent.findMany({
          where: { tenantId, eventType: 'visitor-feedback.potential-urgent-hazard' },
          select: { id: true, occurrenceCount: true },
          orderBy: { id: 'asc' },
        }),
        db.place.findUniqueOrThrow({
          where: { id: attraction.id },
          select: { id: true, name: true, isActive: true, visibility: true },
        }),
        Promise.all([
          db.operationalUpdate.count({ where: { tenantId, venueId: venue.id } }),
          db.venueKnowledgeEntry.count({ where: { tenantId, venueId: venue.id } }),
        ]),
      ])
      expect(siblingEvent.occurrenceCount).toBe(1)
      expect(unchangedAttraction).toEqual(attraction)
      expect(effects).toEqual([0, 0])
      process.stdout.write(
        `VISITOR_FEEDBACK_PROOF ${JSON.stringify({
          eventIds: [event.id, siblingEvent.id],
          feedbackId: feedback.id,
          providerEvidence: 'synthetic-provider-dark-receipts',
          groups: groups.length,
          occurrences: groups.map((group) => group.occurrenceCount).sort((a, b) => a - b),
          unchangedAttraction,
          effects: { operationalUpdates: effects[0], venueKnowledgeEntries: effects[1] },
        })}\n`,
      )
    })
  })
})
