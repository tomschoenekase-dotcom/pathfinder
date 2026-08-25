import { TRPCError } from '@trpc/server'

import { writeAuditLogStrict, type OperationalUpdateDraftFinalizer } from '@pathfinder/db'

import {
  previewSemanticVenueUpdateFromProposal,
  type SemanticVenueUpdatePreviewParameters,
} from './semantic-venue-updater-service'

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

export function semanticOperationalUpdateDraftFinalizer(params: {
  actorId: string
  expectedPreviewHash: string
  previewInput: SemanticVenueUpdatePreviewParameters
}): OperationalUpdateDraftFinalizer {
  return async ({ tx, update }) => {
    const current = await previewSemanticVenueUpdateFromProposal({
      db: tx,
      ...params.previewInput,
    })
    const draft = current.operationalUpdateDraft
    if (
      current.proposalStatus !== 'APPROVED' ||
      current.previewHash !== params.expectedPreviewHash ||
      !draft ||
      update.status !== 'DRAFT' ||
      update.isActive ||
      update.tenantId !== params.previewInput.tenantId ||
      update.venueId !== params.previewInput.venueId ||
      update.updateType !== draft.updateType ||
      update.severity !== draft.severity ||
      update.priority !== draft.priority ||
      update.title !== draft.title ||
      update.body !== draft.body ||
      update.startsAt.toISOString() !== draft.startsAt ||
      update.expiresAt.toISOString() !== draft.expiresAt
    ) {
      conflict('The approved temporal preview changed during update creation.')
    }

    await tx.knowledgeProposalOperationalUpdateHandoff.create({
      data: {
        tenantId: update.tenantId,
        venueId: update.venueId,
        proposalId: params.previewInput.proposalId,
        operationalUpdateId: update.id,
        previewHash: params.expectedPreviewHash,
        createdBy: params.actorId,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: update.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'knowledge-proposal.semantic-operational-update-draft-created-and-linked',
        targetType: 'KnowledgeChangeProposal',
        targetId: params.previewInput.proposalId,
        beforeState: { operationalUpdateLinked: false, proposalStatus: current.proposalStatus },
        afterState: {
          operationalUpdateLinked: true,
          operationalUpdateId: update.id,
          operationalUpdateStatus: 'DRAFT',
          previewHash: params.expectedPreviewHash,
          autoScheduled: false,
          autoPublished: false,
        },
      },
      tx,
    )
  }
}
