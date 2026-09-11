import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

export const adminKnowledgeProposalReadsRouter = router({
  listKnowledgeProposals: adminProcedure
    .input(
      z
        .object({
          ...scope,
          status: z
            .enum([
              'DRAFT',
              'PENDING_REVIEW',
              'APPROVED',
              'REJECTED',
              'PUBLISHED',
              'PUBLISH_FAILED',
            ])
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.knowledgeChangeProposal.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.status ? { status: input.status } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: {
            id: true,
            reviewedDecline: {
              select: { id: true, reviewedProposalUpdatedAt: true, createdAt: true },
            },
            conflictResolutions: { select: { id: true }, take: 1 },
            packageHandoff: { select: { id: true } },
            operationalUpdateHandoff: { select: { id: true } },
            universalContentHandoff: { select: { id: true } },
            legacyContentAdoption: { select: { id: true } },
            duplicateResolution: {
              select: {
                id: true,
                proposalUpdatedAt: true,
                targetKnowledgeEntryId: true,
                relation: true,
                createdAt: true,
              },
            },
            producedByConflictResolution: {
              select: {
                desired: true,
                relation: true,
                proposal: { select: { supportRequestId: true, supportRequestVersion: true } },
              },
            },
            status: true,
            sessionId: true,
            observedVisitorClaim: true,
            aiInference: true,
            proposedChange: true,
            reason: true,
            confidence: true,
            evidenceMessageIds: true,
            targetKnowledgeEntryId: true,
            targetKnowledgeEntry: {
              select: {
                contentModuleId: true,
                contentRevisionId: true,
                contentPublicationId: true,
              },
            },
            conversationInsightId: true,
            supportRequestId: true,
            supportRequestVersion: true,
            createdByType: true,
            createdAt: true,
            updatedAt: true,
            reviewerId: true,
            reviewNote: true,
            reviewedAt: true,
          },
        })
        return rows.map(
          ({
            duplicateResolution,
            reviewedDecline,
            conflictResolutions,
            packageHandoff,
            operationalUpdateHandoff,
            universalContentHandoff,
            legacyContentAdoption,
            producedByConflictResolution,
            targetKnowledgeEntry,
            ...proposal
          }) => {
            const original = producedByConflictResolution?.proposal
            const hasSupportProvenance =
              (proposal.supportRequestId != null && proposal.supportRequestVersion != null) ||
              (original?.supportRequestId != null && original.supportRequestVersion != null)
            const hasLegacyTarget =
              targetKnowledgeEntry != null &&
              targetKnowledgeEntry.contentModuleId == null &&
              targetKnowledgeEntry.contentRevisionId == null &&
              targetKnowledgeEntry.contentPublicationId == null
            return {
              ...proposal,
              canRecordReviewedDecline:
                hasSupportProvenance &&
                (proposal.status === 'PENDING_REVIEW' || proposal.status === 'REJECTED') &&
                !reviewedDecline &&
                !duplicateResolution &&
                !conflictResolutions?.length &&
                !packageHandoff &&
                !operationalUpdateHandoff &&
                !universalContentHandoff &&
                !legacyContentAdoption,
              reviewedDecline: reviewedDecline
                ? {
                    resolutionId: reviewedDecline.id,
                    outcome: 'REVIEWED_DECLINE' as const,
                    createdAt: reviewedDecline.createdAt,
                    proposalRevisionCurrent:
                      proposal.status === 'REJECTED' &&
                      proposal.updatedAt.getTime() ===
                        reviewedDecline.reviewedProposalUpdatedAt.getTime(),
                    currentFulfillmentVerified: false as const,
                  }
                : null,
              duplicateResolution: duplicateResolution
                ? {
                    resolutionId: duplicateResolution.id,
                    outcome: 'DUPLICATE_NOOP' as const,
                    targetKnowledgeEntryId: duplicateResolution.targetKnowledgeEntryId,
                    relation: duplicateResolution.relation,
                    createdAt: duplicateResolution.createdAt,
                    proposalRevisionCurrent:
                      proposal.status === 'APPROVED' &&
                      proposal.updatedAt.getTime() ===
                        duplicateResolution.proposalUpdatedAt.getTime(),
                    currentFulfillmentVerified: false as const,
                  }
                : null,
              hasSupportProvenance,
              hasLegacyTarget,
              resolutionDraft: producedByConflictResolution
                ? {
                    desired: SemanticUpdaterDesiredKnowledge.parse(
                      producedByConflictResolution.desired,
                    ),
                    relation: z
                      .enum(['CORRECTS', 'SUPERSEDES'])
                      .parse(producedByConflictResolution.relation),
                  }
                : null,
            }
          },
        )
      }),
    ),
})
