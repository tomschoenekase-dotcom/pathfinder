import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import { GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 } from '@pathfinder/config/guest-conversation-disposition-policy'
import {
  recordGuestConversationDispositionAuthorization,
  isGuestConversationDisposed,
} from './guest-conversation-disposition'

const rawUrl = process.env.DATABASE_URL ?? ''
const enabled =
  process.env.RUN_GUEST_CONVERSATION_DISPOSITION_DB_INTEGRATION === '1' &&
  /^postgresql:\/\/[^@]+@127\.0\.0\.1:51324\/pathfinder_disposable_guest_lifecycle_[a-f0-9]{12}(?:\?|$)/u.test(
    rawUrl,
  )

describe.skipIf(!enabled)(
  'guest disposition: actual synthetic relational/privilege boundary',
  () => {
    it('erases exact terminal text under closed admission, preserves evidence and rejects ordinary resurrection', async () => {
      const parsed = new URL(rawUrl)
      const database = parsed.pathname.slice(1)
      function client(user: string, name = database) {
        const url = new URL(rawUrl)
        url.username = user
        url.pathname = `/${name}`
        url.searchParams.set('connection_limit', '1')
        return new PrismaClient({ datasourceUrl: url.toString() })
      }
      const control = client('guest_maintenance', 'postgres')
      const admin = client('postgres')
      const application = client('guest_application')
      const maintenance = client('guest_maintenance')
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `disposition-${suffix}`
      const venueId = `venue-${suffix}`
      const sessionId = `session-${suffix}`
      const otherSessionId = `other-${suffix}`
      const token = randomUUID()
      const visitorId = randomUUID()
      const turnId = randomUUID()
      const userMessageId = `user-${suffix}`
      const assistantMessageId = `assistant-${suffix}`
      const operationId = randomUUID()
      const old = new Date('2024-01-01T12:00:00.000Z')
      const policyVersion = 'guest-conversations-terminal-text-v1'
      const request = {
        version: 'guest-conversation-disposition-v1' as const,
        operationId,
        tenantId,
        venueId,
        sessionId,
        expectedPolicyVersion: policyVersion,
        expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
        basis: { kind: 'RETENTION_EXPIRY' as const },
      }
      const authority = {
        version: 'guest-disposition-authority-v1' as const,
        actorId: 'synthetic-platform-operator',
        actorRole: 'PLATFORM_ADMIN' as const,
        policyVersion,
        policySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
        retentionDays: 365 as const,
        holdAssessment: { status: 'NO_KNOWN_HOLD' as const, referenceSha256: '9'.repeat(64) },
        basis: request.basis,
      }
      let reclosed = false
      try {
        const initial = await control.$queryRaw<
          Array<{ closed: boolean }>
        >`SELECT NOT datallowconn AS closed FROM pg_database WHERE datname=${database}`
        expect(initial).toEqual([{ closed: true }])
        // Fixed grammar above makes this identifier safe. This changes only the
        // explicitly opted-in, synthetic disposable database admission property.
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
        for (const sql of [
          'GRANT USAGE ON SCHEMA public TO guest_application,guest_maintenance',
          'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO guest_application',
          'REVOKE INSERT,UPDATE,DELETE ON public.guest_conversation_disposition_operations FROM guest_application',
          'GRANT SELECT ON ALL TABLES IN SCHEMA public TO guest_maintenance',
          'GRANT EXECUTE ON FUNCTION public.pathfinder_authorize_guest_disposition(jsonb,jsonb) TO guest_application,guest_maintenance',
          'GRANT EXECUTE ON FUNCTION public.pathfinder_seal_guest_disposition(uuid,text),public.pathfinder_apply_guest_disposition(uuid,text,text),public.pathfinder_restore_guest_disposition(jsonb,text) TO guest_maintenance',
        ])
          await admin.$executeRawUnsafe(sql)
        await admin.tenant.create({
          data: { id: tenantId, name: 'Synthetic disposition tenant', slug: tenantId },
        })
        await admin.venue.create({
          data: { id: venueId, tenantId, name: 'Synthetic disposition venue', slug: venueId },
        })
        await admin.visitorSession.createMany({
          data: [
            {
              id: sessionId,
              tenantId,
              venueId,
              anonymousToken: token,
              visitorId,
              latestLat: 41,
              latestLng: -87,
              startedAt: old,
              lastActiveAt: old,
            },
            {
              id: otherSessionId,
              tenantId,
              venueId,
              anonymousToken: randomUUID(),
              startedAt: old,
              lastActiveAt: old,
            },
          ],
        })
        await admin.guestChatTurn.create({
          data: {
            id: turnId,
            tenantId,
            venueId,
            sessionId,
            requestId: randomUUID(),
            requestHash: '1'.repeat(64),
            turnSequence: 1,
            userMessageSequence: 1,
            assistantMessageSequence: 2,
            createdAt: old,
            updatedAt: old,
          },
        })
        await admin.guestChatProviderOperation.createMany({
          data: ['QUERY_EMBEDDING', 'RESPONSE_GENERATION'].map((kind) => ({
            id: randomUUID(),
            tenantId,
            venueId,
            sessionId,
            turnId,
            kind: kind as 'QUERY_EMBEDDING' | 'RESPONSE_GENERATION',
            invocationId: randomUUID(),
            createdAt: old,
            updatedAt: old,
          })),
        })
        await admin.guestChatTurn.update({
          where: { id: turnId },
          data: { status: 'GENERATING', updatedAt: old },
        })
        await admin.guestChatProviderOperation.updateMany({
          where: { turnId },
          data: { status: 'DISPATCHED', dispatchedAt: old, updatedAt: old },
        })
        await admin.guestChatProviderOperation.updateMany({
          where: { turnId },
          data: {
            status: 'OBSERVED',
            observedAt: old,
            outcomeCode: 'SYNTHETIC_PROVIDER_DARK',
            updatedAt: old,
          },
        })
        await admin.message.createMany({
          data: [
            {
              id: userMessageId,
              tenantId,
              venueId,
              sessionId,
              guestChatTurnId: turnId,
              sessionSequence: 1,
              turnMessageSequence: 0,
              role: 'user',
              content: 'Synthetic visitor question',
              topic: 'Synthetic topic',
              createdAt: old,
            },
            {
              id: assistantMessageId,
              tenantId,
              venueId,
              sessionId,
              guestChatTurnId: turnId,
              sessionSequence: 2,
              turnMessageSequence: 1,
              role: 'assistant',
              content: 'Synthetic answer and question',
              createdAt: old,
            },
          ],
        })
        await admin.guestChatTurn.update({
          where: { id: turnId },
          data: {
            status: 'COMPLETE',
            userMessageId,
            assistantMessageId,
            completedAt: old,
            replayMetadata: {
              places: [
                { name: 'Synthetic copied locator', url: 'https://example.invalid/private' },
              ],
            },
            responseHash: '2'.repeat(64),
            updatedAt: old,
          },
        })
        await admin.engagementQuestionResponse.create({
          data: {
            tenantId,
            venueId,
            sessionId,
            isAiInvented: true,
            answerType: 'OPEN_ENDED',
            questionText: 'Synthetic engagement question',
            answerText: 'Synthetic engagement answer',
            askedMessageId: assistantMessageId,
            answerMessageId: userMessageId,
            guestChatTurnId: turnId,
            askedAt: old,
            answeredAt: old,
            createdAt: old,
            sentimentLabel: 'Synthetic label',
            category: 'Synthetic category',
          },
        })
        await admin.messageFeedback.create({
          data: {
            tenantId,
            venueId,
            sessionId,
            messageId: assistantMessageId,
            rating: 'HELPFUL',
            reason: 'Synthetic feedback reason',
            createdAt: old,
            updatedAt: old,
          },
        })
        const analyticsBefore = await admin.analyticsEvent.create({
          data: {
            tenantId,
            venueId,
            sessionId,
            eventType: 'message.received',
            metadata: { synthetic: 'copied content' },
            occurredAt: old,
            receivedAt: old,
          },
        })
        const otherBefore = await admin.visitorSession.findUniqueOrThrow({
          where: { id: otherSessionId },
        })
        const preservedBefore = await admin.guestChatTurn.findUniqueOrThrow({
          where: { id: turnId },
        })
        await expect(
          application.message.update({
            where: { id: userMessageId },
            data: { content: 'Forbidden normal edit' },
          }),
        ).rejects.toThrow(/immutable/u)
        const authorized = await recordGuestConversationDispositionAuthorization(
          { request, authority },
          application,
        )
        expect(
          await recordGuestConversationDispositionAuthorization(
            { request, authority },
            application,
          ),
        ).toMatchObject({ ...authorized, replayed: true })
        await expect(
          recordGuestConversationDispositionAuthorization(
            {
              request,
              authority: {
                ...authority,
                holdAssessment: { ...authority.holdAssessment, referenceSha256: '8'.repeat(64) },
              },
            },
            application,
          ),
        ).rejects.toThrow(/OPERATION_CONFLICT/u)
        await expect(
          application.$queryRaw`SELECT public.pathfinder_seal_guest_disposition(${operationId}::uuid,${authorized.requestSha256})`,
        ).rejects.toThrow(/permission denied/u)
        await expect(
          application.$executeRawUnsafe('SET ROLE pathfinder_guest_disposition_executor'),
        ).rejects.toThrow(/permission denied/u)
        await application.$disconnect()
        await admin.$disconnect()
        await maintenance.$queryRaw`SELECT pg_backend_pid()`
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
        reclosed = true
        const intentRows = await maintenance.$queryRaw<
          Array<{ result: Record<string, unknown> }>
        >`SELECT public.pathfinder_seal_guest_disposition(${operationId}::uuid,${authorized.requestSha256}) AS result`
        const intent = intentRows[0]?.result
        expect(intent?.affected).toEqual({
          sessions: 1,
          messages: 2,
          turns: 1,
          engagementResponses: 1,
          feedback: 1,
          analyticsEvents: 1,
        })
        // This case proves DB authorization/mutation/role behavior. The actual
        // fsynced external journal/commit-uncertainty engine has separate proof.
        const intentHash = 'a'.repeat(64)
        const receiptRows = await maintenance.$queryRaw<
          Array<{ result: Record<string, unknown> }>
        >`SELECT public.pathfinder_apply_guest_disposition(${operationId}::uuid,${authorized.requestSha256},${intentHash}) AS result`
        const receipt = receiptRows[0]?.result
        expect(receipt?.affected).toEqual(intent?.affected)
        const replay = await maintenance.$queryRaw<
          Array<{ result: unknown }>
        >`SELECT public.pathfinder_apply_guest_disposition(${operationId}::uuid,${authorized.requestSha256},${intentHash}) AS result`
        expect(replay[0]?.result).toEqual(receipt)
        const session = await maintenance.visitorSession.findUniqueOrThrow({
          where: { id: sessionId },
        })
        expect(session).toMatchObject({
          visitorId,
          latestLat: null,
          latestLng: null,
          anonymousToken: `disposed:${operationId}`,
          dispositionOperationId: operationId,
          startedAt: old,
          lastActiveAt: old,
        })
        expect(
          await maintenance.visitorSession.findUniqueOrThrow({ where: { id: otherSessionId } }),
        ).toEqual(otherBefore)
        const afterTurn = await maintenance.guestChatTurn.findUniqueOrThrow({
          where: { id: turnId },
        })
        expect(afterTurn).toMatchObject({
          status: 'COMPLETE',
          userMessageId,
          assistantMessageId,
          createdAt: old,
          completedAt: old,
          updatedAt: old,
          replayMetadata: {},
        })
        expect(afterTurn.requestHash).not.toBe(preservedBefore.requestHash)
        expect(afterTurn.responseHash).not.toBe(preservedBefore.responseHash)
        expect(
          (await maintenance.message.findMany({ where: { sessionId } })).every(
            (row) => row.content === '' && row.topic === null,
          ),
        ).toBe(true)
        expect(
          await maintenance.engagementQuestionResponse.findFirstOrThrow({ where: { sessionId } }),
        ).toMatchObject({ questionText: '', answerText: '', sentimentLabel: null, category: null })
        expect(
          await maintenance.messageFeedback.findFirstOrThrow({ where: { sessionId } }),
        ).toMatchObject({ rating: 'HELPFUL', reason: null, updatedAt: old })
        expect(
          await maintenance.analyticsEvent.findFirstOrThrow({ where: { sessionId } }),
        ).toMatchObject({
          id: analyticsBefore.id,
          eventType: 'message.received',
          occurredAt: old,
          receivedAt: old,
          metadata: null,
        })
        await maintenance.$disconnect()
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
        reclosed = false
        expect(
          await isGuestConversationDisposed(
            { tenantId, venueId, anonymousToken: token },
            application,
          ),
        ).toBe(true)
        await expect(
          application.visitorSession.create({ data: { tenantId, venueId, anonymousToken: token } }),
        ).rejects.toThrow(/GUEST_CONVERSATION_DISPOSED/u)
        await expect(
          application.message.update({
            where: { id: userMessageId },
            data: { content: 'Late synthetic data' },
          }),
        ).rejects.toThrow(/immutable|GUEST_CONVERSATION_DISPOSED/u)
        await expect(
          application.analyticsEvent.create({
            data: {
              tenantId,
              venueId,
              sessionId,
              eventType: 'message.sent',
              metadata: { late: true },
              occurredAt: old,
            },
          }),
        ).rejects.toThrow(/GUEST_CONVERSATION_DISPOSED/u)
        const newToken = randomUUID()
        const newSession = await application.visitorSession.create({
          data: { tenantId, venueId, anonymousToken: newToken },
        })
        expect(newSession.dispositionOperationId).toBeNull()
      } finally {
        await Promise.all([
          admin.$disconnect(),
          application.$disconnect(),
          maintenance.$disconnect(),
        ])
        if (!reclosed)
          await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
        await control.$disconnect()
      }
    }, 60_000)
    it('refuses concrete unresolved classes and current support revocation without changing any scoped content', async () => {
      const database = new URL(rawUrl).pathname.slice(1)
      const client = (user: string, name = database) => {
        const url = new URL(rawUrl)
        url.username = user
        url.pathname = `/${name}`
        url.searchParams.set('connection_limit', '1')
        return new PrismaClient({ datasourceUrl: url.toString() })
      }
      const control = client('guest_maintenance', 'postgres'),
        admin = client('postgres'),
        maintenance = client('guest_maintenance')
      const cases = [
        'CUTOFF_NOT_ELIGIBLE',
        'VOICE_DISPOSITION_UNRESOLVED',
        'ADMIN_NOTE_DISPOSITION_UNRESOLVED',
        'AGGREGATE_LINEAGE_UNRESOLVED',
        'ACTIVE_WORK',
        'ACCOUNTING_DISPOSITION_UNRESOLVED',
        'ANALYTICS_DISPOSITION_UNRESOLVED',
        'INVENTORY_BOUND_EXCEEDED',
        'SUPPORT_REQUEST_CHANGED',
      ] as const
      const prepared: Array<{
        expected: string
        operationId: string
        requestSha256: string
        sessionId: string
        messageId: string
        original: string
      }> = []
      try {
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
        const old = new Date('2024-01-01T00:00:00Z')
        for (const expected of cases) {
          const suffix = randomUUID().slice(0, 8),
            tenantId = `refusal-${suffix}`,
            venueId = `refusal-venue-${suffix}`,
            sessionId = `refusal-session-${suffix}`,
            messageId = `refusal-message-${suffix}`,
            operationId = randomUUID()
          await admin.tenant.create({
            data: { id: tenantId, slug: tenantId, name: 'Synthetic refusal tenant' },
          })
          await admin.venue.create({
            data: { id: venueId, tenantId, slug: venueId, name: 'Synthetic refusal venue' },
          })
          await admin.visitorSession.create({
            data: {
              id: sessionId,
              tenantId,
              venueId,
              anonymousToken: randomUUID(),
              startedAt: old,
              lastActiveAt: expected === 'CUTOFF_NOT_ELIGIBLE' ? new Date() : old,
            },
          })
          const original =
            expected === 'INVENTORY_BOUND_EXCEEDED'
              ? 'x'.repeat(10 * 1024 * 1024 + 1)
              : 'Synthetic preserved refusal content'
          await admin.message.create({
            data: {
              id: messageId,
              tenantId,
              venueId,
              sessionId,
              sessionSequence: 1,
              role: 'user',
              content: original,
              createdAt: old,
            },
          })
          if (expected === 'VOICE_DISPOSITION_UNRESOLVED')
            await admin.voiceSession.create({
              data: {
                tenantId,
                venueId,
                visitorSessionId: sessionId,
                provider: 'synthetic',
                model: 'synthetic',
                capability: 'synthetic',
                tier: 'synthetic',
                locale: 'en-US',
                voice: 'synthetic',
                entitlementSnapshot: {},
                botConfigurationSnapshot: {},
                maxDurationSeconds: 30,
              },
            })
          if (expected === 'ADMIN_NOTE_DISPOSITION_UNRESOLVED')
            await admin.adminChatlogNote.create({
              data: {
                tenantId,
                venueId,
                sessionId,
                authorId: 'synthetic-operator',
                note: 'Synthetic restricted note',
              },
            })
          // Deliberately disjoint stored dates: unsupported aggregates are refused
          // conservatively, not treated as proven contribution windows.
          if (expected === 'AGGREGATE_LINEAGE_UNRESOLVED')
            await admin.questionCluster.create({
              data: {
                tenantId,
                venueId,
                kind: 'top_question',
                windowStart: new Date('2030-01-01Z'),
                windowEnd: new Date('2030-01-02Z'),
                canonicalText: 'Synthetic aggregate',
                count: 1,
              },
            })
          if (expected === 'ACTIVE_WORK')
            await admin.guestChatTurn.create({
              data: {
                tenantId,
                venueId,
                sessionId,
                requestId: randomUUID(),
                requestHash: '1'.repeat(64),
                turnSequence: 1,
                userMessageSequence: 2,
                assistantMessageSequence: 3,
                createdAt: old,
                updatedAt: old,
              },
            })
          if (expected === 'ACCOUNTING_DISPOSITION_UNRESOLVED')
            await admin.aiUsageEvent.create({
              data: {
                tenantId,
                venueId,
                sessionId,
                feature: 'guest-chat',
                surface: 'guest-web',
                provider: 'anthropic',
                model: 'synthetic',
                pricingVersion: 'synthetic',
                usageObservationStatus: 'UNKNOWN',
                latencyMs: 1,
                success: false,
              },
            })
          if (expected === 'ANALYTICS_DISPOSITION_UNRESOLVED')
            await admin.analyticsEvent.create({
              data: {
                tenantId,
                venueId,
                sessionId,
                eventType: 'unknown.future_event',
                metadata: { synthetic: true },
                occurredAt: old,
              },
            })
          const policyVersion = 'guest-conversations-terminal-text-v1'
          let requestBasis:
            | { kind: 'RETENTION_EXPIRY' }
            | {
                kind: 'SUPPORT_REQUEST'
                supportRequestId: string
                expectedSupportRequestVersion: number
              } = { kind: 'RETENTION_EXPIRY' }
          let authorityBasis:
            | { kind: 'RETENTION_EXPIRY' }
            | {
                kind: 'SUPPORT_REQUEST'
                supportRequestId: string
                supportRequestVersion: number
                reviewedRequesterUserId: string
              } = { kind: 'RETENTION_EXPIRY' }
          let membershipId: string | null = null
          if (expected === 'SUPPORT_REQUEST_CHANGED') {
            const userId = `support-user-${suffix}`
            await admin.user.create({ data: { id: userId, email: `${userId}@example.invalid` } })
            const membership = await admin.tenantMembership.create({
              data: { tenantId, userId, role: 'OWNER', status: 'ACTIVE' },
            })
            membershipId = membership.id
            const support = await admin.supportRequest.create({
              data: {
                tenantId,
                venueId,
                category: 'GENERAL',
                subject: 'Synthetic request',
                createdByKind: 'CLIENT',
                createdById: userId,
                requesterUserId: userId,
                updatedByKind: 'CLIENT',
                updatedById: userId,
              },
            })
            requestBasis = {
              kind: 'SUPPORT_REQUEST',
              supportRequestId: support.id,
              expectedSupportRequestVersion: support.version,
            }
            authorityBasis = {
              kind: 'SUPPORT_REQUEST',
              supportRequestId: support.id,
              supportRequestVersion: support.version,
              reviewedRequesterUserId: userId,
            }
          }
          const result = await recordGuestConversationDispositionAuthorization(
            {
              request: {
                version: 'guest-conversation-disposition-v1',
                operationId,
                tenantId,
                venueId,
                sessionId,
                expectedPolicyVersion: policyVersion,
                expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
                basis: requestBasis,
              },
              authority: {
                version: 'guest-disposition-authority-v1',
                actorId: 'synthetic-platform-operator',
                actorRole: 'PLATFORM_ADMIN',
                policyVersion,
                policySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
                retentionDays: 365,
                holdAssessment: { status: 'NO_KNOWN_HOLD', referenceSha256: '9'.repeat(64) },
                basis: authorityBasis,
              },
            },
            admin,
          )
          if (membershipId)
            await admin.tenantMembership.update({
              where: { id: membershipId },
              data: { status: 'REMOVED' },
            })
          prepared.push({
            expected,
            operationId,
            requestSha256: result.requestSha256,
            sessionId,
            messageId,
            original,
          })
        }
        await admin.$disconnect()
        await maintenance.$queryRaw`SELECT pg_backend_pid()`
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
        for (const row of prepared) {
          await expect(
            maintenance.$queryRaw`SELECT public.pathfinder_seal_guest_disposition(${row.operationId}::uuid,${row.requestSha256})`,
          ).rejects.toThrow(row.expected)
          expect(
            await maintenance.guestConversationDispositionOperation.findUniqueOrThrow({
              where: { id: row.operationId },
            }),
          ).toMatchObject({ state: 'AUTHORIZED', sealedAt: null, externalIntentSha256: null })
          expect(
            (await maintenance.visitorSession.findUniqueOrThrow({ where: { id: row.sessionId } }))
              .dispositionOperationId,
          ).toBeNull()
          expect(
            (await maintenance.message.findUniqueOrThrow({ where: { id: row.messageId } })).content,
          ).toBe(row.original)
          if (row.expected === 'ANALYTICS_DISPOSITION_UNRESOLVED') {
            expect(
              await maintenance.analyticsEvent.findFirstOrThrow({
                where: { sessionId: row.sessionId },
              }),
            ).toMatchObject({ eventType: 'unknown.future_event', metadata: { synthetic: true } })
          }
        }
      } finally {
        await Promise.all([admin.$disconnect(), maintenance.$disconnect()])
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
        await control.$disconnect()
      }
    }, 60_000)
  },
)
