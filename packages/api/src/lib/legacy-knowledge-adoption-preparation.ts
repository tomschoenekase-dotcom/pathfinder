import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import type { CreateLegacyKnowledgeAdoptionDraftInput } from '@pathfinder/contracts/legacy-knowledge-adoption'

import type { TRPCContext } from '../context'
import { legacyKnowledgeSnapshotHash } from './legacy-knowledge-adoption'
import {
  legacyKnowledgeSnapshot,
  loadLegacyKnowledgeEntry,
} from './legacy-knowledge-adoption-service'
import { SemanticUpdaterDesiredKnowledge } from './semantic-venue-updater'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

export const LegacyKnowledgeAdoptionPreparationInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    proposalId: z.string().uuid(),
    expectedUpdatedAt: z.coerce.date(),
    relation: z.enum(['CORRECTS', 'SUPERSEDES']),
    desired: SemanticUpdaterDesiredKnowledge,
  })
  .strict()

type ScopedDb = TRPCContext['db']
export type LegacyKnowledgeAdoptionPreparation = Omit<
  CreateLegacyKnowledgeAdoptionDraftInput,
  'draft'
>

/**
 * Reads one exact approved semantic correction and its unlinked legacy target. It creates no
 * native content, adoption receipt, publication, or provenance evidence.
 */
export async function prepareLegacyKnowledgeAdoptionDraftService(params: {
  db: ScopedDb
  input: unknown
}): Promise<LegacyKnowledgeAdoptionPreparation> {
  const input = LegacyKnowledgeAdoptionPreparationInput.parse(params.input)
  const preview = await previewSemanticVenueUpdateFromProposal({
    db: params.db,
    tenantId: input.tenantId,
    venueId: input.venueId,
    proposalId: input.proposalId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    relation: input.relation,
    desired: input.desired,
  })
  if (preview.proposalStatus !== 'APPROVED') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Human evidence approval is required before preparing a legacy adoption draft.',
    })
  }
  if (!['CORRECTION', 'SUPERSESSION'].includes(preview.classification)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Only a correction or supersession target can be prepared for legacy adoption.',
    })
  }
  if (!preview.targetKnowledgeEntryId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A legacy adoption draft requires one exact target knowledge entry.',
    })
  }
  const legacy = await loadLegacyKnowledgeEntry(params.db, {
    tenantId: input.tenantId,
    venueId: input.venueId,
    id: preview.targetKnowledgeEntryId,
  })
  if (!legacy)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Legacy knowledge source not found.' })
  if (legacy.contentModuleId || legacy.contentRevisionId || legacy.contentPublicationId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The knowledge source is already native.',
    })
  }
  const snapshot = legacyKnowledgeSnapshot(legacy)
  return {
    tenantId: input.tenantId,
    venueId: input.venueId,
    proposalId: input.proposalId,
    legacyKnowledgeEntryId: legacy.id,
    expectedProposalUpdatedAt: input.expectedUpdatedAt.toISOString(),
    expectedPreviewHash: preview.previewHash,
    expectedLegacyUpdatedAt: legacy.updatedAt.toISOString(),
    expectedLegacySnapshotHash: legacyKnowledgeSnapshotHash(snapshot),
    relation: input.relation,
    desired: input.desired,
  }
}
