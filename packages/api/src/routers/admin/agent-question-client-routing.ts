import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  OnboardingQuestionActionError,
  createClientOnboardingQuestionAction,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminAgentQuestionClientRoutingRouter = router({
  listOnboardingQuestionRecipients: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        return db.tenantMembership.findMany({
          where: { tenantId: input.tenantId, status: 'ACTIVE' },
          orderBy: [{ role: 'desc' }, { userId: 'asc' }],
          select: {
            userId: true,
            role: true,
            user: { select: { fullName: true, email: true } },
          },
        })
      }),
    ),

  routeAgentQuestionToClient: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          questionId: z.string().min(1),
          expectedUpdatedAt: z.string().datetime(),
          recipientUserId: z.string().min(1),
          category: z
            .enum([
              'CONTENT_CORRECTION',
              'OPERATIONAL_UPDATE',
              'BRANDING',
              'EXPERIENCE_BEHAVIOR',
              'ACCESSIBILITY',
              'GENERAL',
            ])
            .default('GENERAL'),
          subject: z.string().trim().min(1).max(200),
          why: z.string().trim().min(1).max(2000),
          whatWasFound: z.string().trim().min(1).max(2000).optional(),
          effect: z.string().trim().min(1).max(1000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await createClientOnboardingQuestionAction(
            {
              operationId: input.operationId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              agentQuestionId: input.questionId,
              expectedQuestionUpdatedAt: new Date(input.expectedUpdatedAt),
              recipientUserId: input.recipientUserId,
              category: input.category,
              subject: input.subject,
              why: input.why,
              ...(input.whatWasFound ? { whatWasFound: input.whatWasFound } : {}),
              effect: input.effect,
              actor: { actorId: ctx.session.userId, auditRole: 'PLATFORM_ADMIN' },
            },
            db,
          )
        } catch (error) {
          if (error instanceof OnboardingQuestionActionError)
            throw new TRPCError({
              code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
              message: error.message,
            })
          throw error
        }
      }),
    ),
})
