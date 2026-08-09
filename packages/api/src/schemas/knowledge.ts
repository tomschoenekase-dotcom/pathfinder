import { z } from 'zod'
import { KnowledgeEntryInput as VenuePackageKnowledgeEntryInput } from '@pathfinder/contracts'

// Preserve the legacy bulk-create behavior that strips unknown keys. Venue Package v1
// imports use the strict shared contract directly at their boundary.
export const KnowledgeEntryInput = VenuePackageKnowledgeEntryInput.strip()

export const CreateKnowledgeEntryInput = z.object({
  venueId: z.string().cuid(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  isEnabled: z.boolean().default(true),
})

export const BulkCreateKnowledgeEntriesInput = z
  .object({
    venueId: z.string().cuid(),
    entries: z.array(KnowledgeEntryInput),
  })
  .strict()

export const UpdateKnowledgeEntryInput = z.object({
  id: z.string().cuid(),
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).max(5000).optional(),
  isEnabled: z.boolean().optional(),
})

export type CreateKnowledgeEntryInput = z.infer<typeof CreateKnowledgeEntryInput>
export type KnowledgeEntryInput = z.infer<typeof KnowledgeEntryInput>
export type BulkCreateKnowledgeEntriesInput = z.infer<typeof BulkCreateKnowledgeEntriesInput>
export type UpdateKnowledgeEntryInput = z.infer<typeof UpdateKnowledgeEntryInput>
