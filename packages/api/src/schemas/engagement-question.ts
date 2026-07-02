import { z } from 'zod'

const ChoiceOptionInput = z.string().trim().min(1).max(100)

export const EngagementQuestionTypeInput = z.enum(['OPEN_ENDED', 'MULTIPLE_CHOICE'])

export const CreateEngagementQuestionInput = z
  .object({
    questionType: EngagementQuestionTypeInput,
    prompt: z.string().trim().min(1).max(500),
    choiceOptions: z.array(ChoiceOptionInput).max(4).default([]),
    intensity: z.number().int().min(1).max(5).default(3),
  })
  .strict()

export const UpdateEngagementQuestionInput = z
  .object({
    id: z.string().cuid(),
    questionType: EngagementQuestionTypeInput.optional(),
    prompt: z.string().trim().min(1).max(500).optional(),
    choiceOptions: z.array(ChoiceOptionInput).max(4).optional(),
    intensity: z.number().int().min(1).max(5).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
