import { z } from 'zod'

export const CreateKnowledgeEntryInput = z.object({
  venueId: z.string().cuid(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  isEnabled: z.boolean().default(true),
})

export const UpdateKnowledgeEntryInput = z.object({
  id: z.string().cuid(),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(5000).optional(),
  isEnabled: z.boolean().optional(),
})

export type CreateKnowledgeEntryInput = z.infer<typeof CreateKnowledgeEntryInput>
export type UpdateKnowledgeEntryInput = z.infer<typeof UpdateKnowledgeEntryInput>
