import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GuestAnswerClaimInputSchema } from '@pathfinder/contracts/guest-answer-attribution'
import {
  db,
  GuestAnswerAttributionActionError,
  recordHumanReviewedGuestAnswerAttributionAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scopeSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
  })
  .strict()

const evaluatorSchema = z
  .object({
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(191),
    configurationVersion: z.string().trim().min(1).max(191),
    promptVersion: z.string().trim().min(1).max(191),
  })
  .strict()

function mapActionError(error: unknown): never {
  if (error instanceof GuestAnswerAttributionActionError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'PRECONDITION_FAILED'
            ? 'PRECONDITION_FAILED'
            : error.code,
      message: error.message,
      cause: error,
    })
  }
  throw error
}

const attributionSelect = {
  id: true,
  operationId: true,
  guestChatTurnId: true,
  schemaVersion: true,
  answerHash: true,
  evidenceSetHash: true,
  evaluatorProvider: true,
  evaluatorModel: true,
  evaluatorConfiguration: true,
  evaluatorPromptVersion: true,
  attributionSnapshot: true,
  claimCount: true,
  supportedCount: true,
  unsupportedCount: true,
  uncertainCount: true,
  nonFactualCount: true,
  supportRate: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} as const

export const adminGuestAnswerAttributionsRouter = router({
  recordHumanReviewedGuestAnswerAttribution: adminProcedure
    .input(
      scopeSchema
        .extend({
          operationId: z.string().uuid(),
          guestChatTurnId: z.string().uuid(),
          evaluator: evaluatorSchema,
          claims: z.array(GuestAnswerClaimInputSchema).max(100),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await withTenantIsolationBypass(() =>
          recordHumanReviewedGuestAnswerAttributionAction(
            {
              ...input,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  listGuestAnswerAttributions: adminProcedure
    .input(
      scopeSchema
        .extend({
          guestChatTurnId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.guestAnswerAttribution.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.guestChatTurnId ? { guestChatTurnId: input.guestChatTurnId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: attributionSelect,
        }),
      ),
    ),
})
