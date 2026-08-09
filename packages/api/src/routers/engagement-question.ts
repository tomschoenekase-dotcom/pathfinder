import { TRPCError } from '@trpc/server'
import { z } from 'zod'

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

const engagementQuestionSelect = {
  id: true,
  tenantId: true,
  questionType: true,
  prompt: true,
  choiceOptions: true,
  intensity: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

const MULTIPLE_CHOICE_MIN = 2
const MULTIPLE_CHOICE_MAX = 4

function assertValidChoiceOptions(questionType: string, choiceOptions: string[]): void {
  if (
    questionType === 'MULTIPLE_CHOICE' &&
    (choiceOptions.length < MULTIPLE_CHOICE_MIN || choiceOptions.length > MULTIPLE_CHOICE_MAX)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Multiple-choice questions need ${MULTIPLE_CHOICE_MIN} to ${MULTIPLE_CHOICE_MAX} choice options`,
    })
  }
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
      const tenantId = ctx.session.activeTenantId

      assertValidChoiceOptions(input.questionType, input.choiceOptions)

      return ctx.db.engagementQuestion.create({
        data: {
          tenantId,
          questionType: input.questionType,
          prompt: input.prompt,
          choiceOptions: input.questionType === 'MULTIPLE_CHOICE' ? input.choiceOptions : [],
          intensity: input.intensity,
        },
        select: engagementQuestionSelect,
      })
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateEngagementQuestionInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: engagementQuestionSelect,
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }
      if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Engagement question changed in another session. Refresh and try again.',
        })
      }

      const effectiveType = input.questionType ?? existing.questionType
      const effectiveOptions = input.choiceOptions ?? existing.choiceOptions
      assertValidChoiceOptions(effectiveType, effectiveOptions)

      const data = {
        ...(input.questionType !== undefined ? { questionType: input.questionType } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.choiceOptions !== undefined ? { choiceOptions: input.choiceOptions } : {}),
        ...(input.intensity !== undefined ? { intensity: input.intensity } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)),
      }

      const changed = await ctx.db.engagementQuestion.updateMany({
        where: { id: input.id, tenantId, updatedAt: input.expectedUpdatedAt },
        data,
      })
      if (changed.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Engagement question changed in another session. Refresh and try again.',
        })
      }

      const updated = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: engagementQuestionSelect,
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid(), expectedUpdatedAt: z.coerce.date() }).strict())
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true, updatedAt: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }
      if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Engagement question changed in another session. Refresh and try again.',
        })
      }

      const deleted = await ctx.db.engagementQuestion.deleteMany({
        where: { id: input.id, tenantId, updatedAt: input.expectedUpdatedAt },
      })
      if (deleted.count !== 1) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Engagement question changed in another session. Refresh and try again.',
        })
      }

      return { id: input.id }
    }),
})
