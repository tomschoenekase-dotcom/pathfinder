import { z } from 'zod'

import { GeneralizedContentRevisionDraft } from './universal-content-actions'

export const LegacyKnowledgeSnapshot = z
  .object({
    id: z.string().trim().min(1).max(191),
    title: z.string(),
    category: z.string(),
    content: z.string(),
    isEnabled: z.boolean(),
    visibility: z.string(),
    sourceType: z.string(),
    authorship: z.string(),
    sourceName: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    importedAt: z.string().datetime({ offset: true }).nullable(),
    humanConfirmedAt: z.string().datetime({ offset: true }).nullable(),
    humanConfirmedBy: z.string().nullable(),
    lastReviewedAt: z.string().datetime({ offset: true }).nullable(),
    lastReviewedBy: z.string().nullable(),
    sourcePackageId: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
export type LegacyKnowledgeSnapshot = z.infer<typeof LegacyKnowledgeSnapshot>

/**
 * Draft-only adoption of one exact legacy row. Publication is intentionally
 * absent and must use the existing separately approved publication action.
 */
export const CreateLegacyKnowledgeAdoptionDraftInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    proposalId: z.string().uuid(),
    legacyKnowledgeEntryId: z.string().trim().min(1).max(191),
    expectedProposalUpdatedAt: z.string().datetime({ offset: true }),
    expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedLegacyUpdatedAt: z.string().datetime({ offset: true }),
    expectedLegacySnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    relation: z.enum(['CORRECTS', 'SUPERSEDES']),
    desired: z
      .object({
        title: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100),
        content: z.string().trim().min(1).max(5000),
        isEnabled: z.boolean(),
      })
      .strict(),
    draft: GeneralizedContentRevisionDraft,
  })
  .strict()
export type CreateLegacyKnowledgeAdoptionDraftInput = z.infer<
  typeof CreateLegacyKnowledgeAdoptionDraftInput
>
