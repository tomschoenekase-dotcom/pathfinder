import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  createEngagementQuestionAction,
  deleteEngagementQuestionAction,
  engagementQuestionSelect,
  EngagementQuestionActionError,
  updateEngagementQuestionAction,
} from '@pathfinder/db'

import {
  CreateEngagementQuestionInput,
  UpdateEngagementQuestionInput,
} from '../schemas/engagement-question'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export {
  CreateEngagementQuestionInput,
  UpdateEngagementQuestionInput,
} from '../schemas/engagement-question'

function mapActionError(error: unknown): never {
  if (error instanceof EngagementQuestionActionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}

export const engagementQuestionRouter = router({
  list: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.engagementQuestion.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      select: engagementQuestionSelect,
      orderBy: { createdAt: 'asc' },
    })
  }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateEngagementQuestionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createEngagementQuestionAction({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          questionType: input.questionType,
          prompt: input.prompt,
          choiceOptions: input.choiceOptions,
          intensity: input.intensity,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: ctx.session.role as 'OWNER' | 'MANAGER',
          },
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateEngagementQuestionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await updateEngagementQuestionAction({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          questionId: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
          patch: {
            ...(input.questionType !== undefined ? { questionType: input.questionType } : {}),
            ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
            ...(input.choiceOptions !== undefined ? { choiceOptions: input.choiceOptions } : {}),
            ...(input.intensity !== undefined ? { intensity: input.intensity } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          },
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: ctx.session.role as 'OWNER' | 'MANAGER',
          },
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid(), expectedUpdatedAt: z.coerce.date() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await deleteEngagementQuestionAction({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          questionId: input.id,
          expectedUpdatedAt: input.expectedUpdatedAt,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: ctx.session.role as 'OWNER' | 'MANAGER',
          },
        })
      } catch (error) {
        mapActionError(error)
      }
    }),
})
