import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { materializeDueFirstWeekAccountReviews } from './first-week-account-reviews'

const enabled =
  process.env.RUN_FIRST_WEEK_LEARNING_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_first_week_learning_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('first-week account learning disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('materializes release-anchored aggregate reviews without sending or cross-tenant leakage', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-first-week-${suffix}`
      const otherTenantId = `tenant-first-week-other-${suffix}`
      const venueId = `venue-first-week-${suffix}`
      const quietVenueId = `venue-first-week-quiet-${suffix}`
      const releaseAt = new Date('2026-08-10T00:00:00.000Z')
      const releaseId = randomUUID()
      const quietReleaseId = randomUUID()

      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Synthetic first-week tenant', slug: tenantId },
          { id: otherTenantId, name: 'Synthetic other tenant', slug: otherTenantId },
        ],
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Active synthetic venue', slug: venueId },
          { id: quietVenueId, tenantId, name: 'Quiet synthetic venue', slug: quietVenueId },
        ],
      })
      await db.onboardingMilestoneEvent.createMany({
        data: [
          {
            id: releaseId,
            tenantId,
            venueId,
            eventType: 'RELEASED',
            idempotencyKey: `release:${suffix}`,
            identityHash: 'a'.repeat(64),
            occurredAt: releaseAt,
            actorType: 'SYSTEM',
            sourceType: 'NATIVE_RELEASE',
            sourceId: `release:${suffix}`,
          },
          {
            id: quietReleaseId,
            tenantId,
            venueId: quietVenueId,
            eventType: 'RELEASED',
            idempotencyKey: `quiet-release:${suffix}`,
            identityHash: 'b'.repeat(64),
            occurredAt: releaseAt,
            actorType: 'SYSTEM',
            sourceType: 'NATIVE_RELEASE',
            sourceId: `quiet-release:${suffix}`,
          },
        ],
      })

      const sessionId = `session-first-week-${suffix}`
      await db.visitorSession.create({
        data: {
          id: sessionId,
          tenantId,
          venueId,
          anonymousToken: randomUUID(),
          experienceScope: 'PUBLIC',
          startedAt: new Date('2026-08-10T04:00:00.000Z'),
        },
      })
      const userMessage = await db.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 1,
          role: 'user',
          content: 'Synthetic private question excluded from review storage.',
          createdAt: new Date('2026-08-10T04:01:00.000Z'),
        },
      })
      const assistantMessage = await db.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 2,
          role: 'assistant',
          content: 'Synthetic answer.',
          createdAt: new Date('2026-08-10T04:02:00.000Z'),
        },
      })
      await db.messageFeedback.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          messageId: assistantMessage.id,
          rating: 'NOT_HELPFUL',
          reason: 'Synthetic private reason excluded from review storage.',
          createdAt: new Date('2026-08-10T04:03:00.000Z'),
        },
      })
      await db.conversationInsight.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          category: 'KNOWLEDGE_GAP',
          confidence: '0.9000',
          severity: 'MEDIUM',
          summary: 'Synthetic private insight excluded from review storage.',
          evidenceMessageIds: [userMessage.id],
          capability: 'synthetic',
          provider: 'deterministic',
          model: 'fixture',
          analyzerVersion: 'integration-v1',
          createdAt: new Date('2026-08-10T04:04:00.000Z'),
        },
      })
      await db.aiUsageEvent.createMany({
        data: [
          {
            tenantId,
            venueId,
            sessionId,
            feature: 'guest-chat',
            surface: 'visitor',
            provider: 'deterministic',
            model: 'fixture',
            pricingVersion: 'fixture-v1',
            totalTokens: 10,
            estimatedCostUsd: '0.01000000',
            latencyMs: 10,
            success: true,
            createdAt: new Date('2026-08-10T04:02:00.000Z'),
          },
          {
            tenantId,
            venueId,
            sessionId,
            feature: 'guest-chat',
            surface: 'visitor',
            provider: 'deterministic',
            model: 'fixture',
            pricingVersion: 'fixture-v1',
            totalTokens: 0,
            estimatedCostUsd: '0',
            latencyMs: 5,
            success: false,
            errorCode: 'synthetic-failure',
            createdAt: new Date('2026-08-10T04:05:00.000Z'),
          },
        ],
      })

      const first = await materializeDueFirstWeekAccountReviews({
        tenantId,
        venueId,
        now: new Date('2026-08-17T00:00:00.000Z'),
        systemJobId: `job-first-week-${suffix}`,
      })
      expect(first).toHaveLength(3)
      expect(first.every((review) => review.replayed === false)).toBe(true)
      expect(first.map((review) => review.milestone)).toEqual(['DAY_1', 'DAY_3', 'DAY_7'])
      expect(first.every((review) => review.disposition === 'DRAFT_READY')).toBe(true)
      expect(first[0]?.metrics).toMatchObject({
        publicSessions: 1,
        guestQuestions: 1,
        knowledgeGapInsights: 1,
        negativeFeedback: 1,
        aiRequests: 2,
        failedAiRequests: 1,
        estimatedAiCostUsd: '0.01',
      })
      expect(JSON.stringify(first)).not.toContain('Synthetic private')

      const replay = await materializeDueFirstWeekAccountReviews({
        tenantId,
        venueId,
        now: new Date('2026-08-18T00:00:00.000Z'),
        systemJobId: `job-first-week-replay-${suffix}`,
      })
      expect(replay.every((review) => review.replayed === true)).toBe(true)
      expect(
        await db.operationalEvent.findMany({
          where: { tenantId, eventType: 'customer-learning.first-week-draft-ready' },
          select: { occurrenceCount: true },
        }),
      ).toEqual([{ occurrenceCount: 1 }, { occurrenceCount: 1 }, { occurrenceCount: 1 }])

      const quiet = await materializeDueFirstWeekAccountReviews({
        tenantId,
        venueId: quietVenueId,
        now: new Date('2026-08-17T00:00:00.000Z'),
      })
      expect(quiet).toHaveLength(3)
      expect(quiet.every((review) => review.disposition === 'NO_ACTION')).toBe(true)
      expect(await db.operationalEvent.count({ where: { tenantId, venueId: quietVenueId } })).toBe(
        0,
      )

      await expect(
        materializeDueFirstWeekAccountReviews({
          tenantId: otherTenantId,
          venueId,
          now: new Date('2026-08-17T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
      await expect(
        db.firstWeekAccountReview.update({
          where: { id: first[0]!.id },
          data: { draftBody: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/iu)
      await expect(
        db.firstWeekAccountReview.delete({ where: { id: first[0]!.id } }),
      ).rejects.toThrow(/append-only/iu)

      expect(
        await db.auditLog.count({
          where: { tenantId, action: 'first-week-account-review.materialized' },
        }),
      ).toBe(6)
      expect(await db.operationalEventDelivery.count({ where: { tenantId } })).toBe(0)
      expect(await db.firstWeekAccountReview.count({ where: { tenantId: otherTenantId } })).toBe(0)
    })
  })
})
