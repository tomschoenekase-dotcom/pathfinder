import { TRPCError } from '@trpc/server'

import { writeAuditLogStrict } from '@pathfinder/db'

import { venuePackagePayloadHash } from './venue-package-identity'
import type { VenuePackageDraftFinalizer } from './venue-package-draft-finalizer'
import {
  previewSemanticVenueUpdateFromProposal,
  type SemanticVenueUpdatePreviewParameters,
} from './semantic-venue-updater-service'

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

export function semanticVenueUpdateDraftFinalizer(params: {
  actorId: string
  expectedPreviewHash: string
  previewInput: SemanticVenueUpdatePreviewParameters
}): VenuePackageDraftFinalizer {
  return async (input) => {
    if (!input.replayed && input.status !== 'DRAFT') {
      conflict('Only a new semantic VenuePackage DRAFT may be attached.')
    }
    if (input.preview.report.semanticDuplicateScan.status !== 'COMPLETE') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Semantic update DRAFT requires complete duplicate-analysis evidence.',
      })
    }

    const current = await previewSemanticVenueUpdateFromProposal({
      db: input.tx,
      ...params.previewInput,
    })
    if (
      current.proposalStatus !== 'APPROVED' ||
      current.previewHash !== params.expectedPreviewHash ||
      !current.venuePackagePatch ||
      venuePackagePayloadHash(input.venueId, current.venuePackagePatch) !==
        input.preview.payloadHash
    ) {
      conflict('The approved semantic preview changed during package creation.')
    }

    const replay = await input.tx.knowledgeProposalPackageHandoff.findFirst({
      where: {
        proposalId: params.previewInput.proposalId,
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
      select: { id: true, venuePackageId: true, previewHash: true },
    })
    if (input.replayed) {
      if (
        replay?.venuePackageId !== input.packageId ||
        replay.previewHash !== params.expectedPreviewHash
      ) {
        conflict('Package replay is not the exact semantic proposal handoff.')
      }
      return { packageId: input.packageId, handoffId: replay.id, replayed: true as const }
    }
    if (replay) conflict('The knowledge proposal already has a package handoff.')

    const handoff = await input.tx.knowledgeProposalPackageHandoff.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: params.previewInput.proposalId,
        venuePackageId: input.packageId,
        previewHash: params.expectedPreviewHash,
        createdBy: params.actorId,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'knowledge-proposal.semantic-package-draft-created-and-linked',
        targetType: 'KnowledgeChangeProposal',
        targetId: params.previewInput.proposalId,
        beforeState: { packageLinked: false, proposalStatus: current.proposalStatus },
        afterState: {
          packageLinked: true,
          venuePackageId: input.packageId,
          packageStatus: 'DRAFT',
          previewHash: params.expectedPreviewHash,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
      input.tx,
    )
    return { packageId: input.packageId, handoffId: handoff.id, replayed: false as const }
  }
}
