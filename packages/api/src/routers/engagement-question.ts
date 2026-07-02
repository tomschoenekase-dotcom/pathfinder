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

      const effectiveType = input.questionType ?? existing.questionType
      const effectiveOptions = input.choiceOptions ?? existing.choiceOptions
      assertValidChoiceOptions(effectiveType, effectiveOptions)

      const { id, ...raw } = input
      const data = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))

      await ctx.db.engagementQuestion.updateMany({ where: { id, tenantId }, data })

      const updated = await ctx.db.engagementQuestion.findFirst({
        where: { id, tenantId },
        select: engagementQuestionSelect,
      })

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      return updated
    }),

  delete: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ id: z.string().cuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.engagementQuestion.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Engagement question not found' })
      }

      await ctx.db.engagementQuestion.deleteMany({ where: { id: input.id, tenantId } })

      return { id: input.id }
    }),
})
