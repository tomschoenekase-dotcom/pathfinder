import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { recordConversationInsightSignals } from '@pathfinder/db'

import { router } from '../core'
import { checkRateLimit } from '../lib/rate-limit'
import { publicProcedure } from '../trpc'

const input = z
  .object({
    venueId: z.string().cuid(),
    anonymousToken: z.string().uuid(),
    messageId: z.string().min(1).max(191),
    rating: z.enum(['HELPFUL', 'NOT_HELPFUL']),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()

export const feedbackRouter = router({
  submit: publicProcedure.input(input).mutation(async ({ ctx, input: rating }) => {
    const allowed = await checkRateLimit(
      `ratelimit:message-feedback:${rating.venueId}:${rating.anonymousToken}`,
      30,
      60,
    )
    if (!allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many feedback requests.' })
    }

    // Resolve authoritative tenant scope from the opaque session token. A public
    // caller can never submit a tenant identity or rate a private-scope message.
    const [target] = await ctx.db.$queryRaw<
      {
        tenantId: string
        venueId: string
        sessionId: string
        messageId: string
        guestChatTurnId: string | null
        userMessageId: string | null
      }[]
    >`
      SELECT sessions.tenant_id AS "tenantId",
             sessions.venue_id AS "venueId",
             sessions.id AS "sessionId",
             messages.id AS "messageId",
             turns.id AS "guestChatTurnId",
             turns.user_message_id AS "userMessageId"
        FROM visitor_sessions sessions
        JOIN messages
          ON messages.session_id = sessions.id
         AND messages.tenant_id = sessions.tenant_id
         AND messages.venue_id = sessions.venue_id
        LEFT JOIN guest_chat_turns turns
          ON turns.id = messages.guest_chat_turn_id
         AND turns.assistant_message_id = messages.id
         AND turns.session_id = sessions.id
         AND turns.tenant_id = sessions.tenant_id
         AND turns.venue_id = sessions.venue_id
       WHERE sessions.venue_id = ${rating.venueId}
         AND sessions.anonymous_token = ${rating.anonymousToken}
         AND sessions.experience_scope = 'PUBLIC'
         AND messages.id = ${rating.messageId}
         AND messages.role = 'assistant'
       LIMIT 1
    `
    if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found.' })

    await ctx.db.$transaction(async (tx) => {
      await tx.messageFeedback.upsert({
        where: {
          tenantId_venueId_sessionId_messageId: {
            tenantId: target.tenantId,
            venueId: target.venueId,
            sessionId: target.sessionId,
            messageId: target.messageId,
          },
        },
        create: {
          tenantId: target.tenantId,
          venueId: target.venueId,
          sessionId: target.sessionId,
          messageId: target.messageId,
          rating: rating.rating,
          reason: rating.reason ?? null,
        },
        update: { rating: rating.rating, reason: rating.reason ?? null },
      })
      if (rating.rating === 'NOT_HELPFUL' && target.guestChatTurnId && target.userMessageId) {
        await recordConversationInsightSignals({
          client: tx,
          signals: [
            {
              tenantId: target.tenantId,
              venueId: target.venueId,
              sessionId: target.sessionId,
              guestChatTurnId: target.guestChatTurnId,
              category: 'VISITOR_NEGATIVE_FEEDBACK',
              confidence: 1,
              severity: 'INFO',
              summary: 'A visitor explicitly rated this public answer as not helpful.',
              suggestedAction:
                'Review the question, answer, and current venue knowledge before proposing a correction.',
              evidenceMessageIds: [target.userMessageId, target.messageId],
              capability: 'VISITOR_FEEDBACK',
              provider: 'pathfinder',
              model: 'explicit-visitor-feedback',
              analyzerVersion: 'visitor-feedback-signals-v1',
            },
          ],
        })
      }
      await tx.analyticsEvent.create({
        data: {
          tenantId: target.tenantId,
          venueId: target.venueId,
          sessionId: target.sessionId,
          eventType: 'chat.response.feedback',
          occurredAt: new Date(),
          metadata: { messageId: target.messageId, rating: rating.rating },
        },
      })
    })
    return { ok: true as const }
  }),
})
