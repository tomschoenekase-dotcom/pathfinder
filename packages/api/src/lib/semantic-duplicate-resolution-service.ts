import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { lockVenueContentMutation, writeAuditLogStrict } from '@pathfinder/db'
import type { TRPCContext } from '../context'
import { SemanticDuplicateResolutionInput } from './semantic-duplicate-resolution-contract'
import { hashSemanticConflictTarget } from './semantic-conflict-resolution-contract'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'
import { resolveSupportProposalContentEvidence } from './support-proposal-content-evidence'

const conflict = (message: string): never => {
  throw new TRPCError({ code: 'CONFLICT', message })
}

// The canonical support writer stores a newline after its typed envelope.
// Compare exact permitted encodings; never strip an arbitrary tag or alter approved wording.
function matchesReviewedBody(stored: string, body: string): boolean {
  return (
    stored === body ||
    ['CREATE_KNOWLEDGE', 'UPDATE_KNOWLEDGE', 'NO_CONTENT_CHANGE'].some(
      (kind) => stored === `[${kind}]\n${body}`,
    )
  )
}

/** Explicit admin review of a support duplicate. Never changes canonical or proposal state. */
export async function resolveSemanticDuplicateService(params: {
  db: TRPCContext['db']
  actorId: string
  input: unknown
}) {
  const input = SemanticDuplicateResolutionInput.parse(params.input)
  if (!params.actorId.trim()) throw new TRPCError({ code: 'FORBIDDEN' })
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ ...input, actorId: params.actorId }))
    .digest('hex')
  const result = (id: string, replayed: boolean) => ({
    resolutionId: id,
    outcome: 'DUPLICATE_NOOP' as const,
    replayed,
    canonicalKnowledgeChanged: false as const,
    approvalGranted: false as const,
    completionGranted: false as const,
    // Replays recover the immutable decision, not a claim about today's canonical state.
    currentFulfillmentVerified: false as const,
  })
  return params.db
    .$transaction(async (rawTx) => {
      const tx = rawTx as unknown as TRPCContext['db']
      await lockVenueContentMutation(tx, input)
      const where = { tenantId: input.tenantId, venueId: input.venueId }
      const existing = await tx.semanticDuplicateResolution.findFirst({
        where: { ...where, id: input.operationId },
      })
      if (existing) {
        if (existing.inputHash !== inputHash)
          conflict('Duplicate decision operation is bound to another input or reviewer.')
        return result(existing.id, true)
      }
      const prior = await tx.semanticDuplicateResolution.findFirst({
        where: { ...where, proposalId: input.proposalId },
      })
      if (prior) conflict('This proposal already has an immutable duplicate decision.')
      await tx.$queryRaw`SELECT id FROM knowledge_change_proposals WHERE id=${input.proposalId}::uuid AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR UPDATE`
      const proposal = await tx.knowledgeChangeProposal.findFirst({
        where: { ...where, id: input.proposalId },
        include: {
          packageHandoff: { select: { proposalId: true } },
          operationalUpdateHandoff: { select: { id: true } },
          universalContentHandoff: { select: { id: true } },
          legacyContentAdoption: { select: { id: true } },
          conflictResolutions: { select: { id: true }, take: 1 },
        },
      })
      if (!proposal)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
      if (
        proposal.status !== 'APPROVED' ||
        proposal.updatedAt.toISOString() !== input.expectedProposalUpdatedAt ||
        !matchesReviewedBody(proposal.proposedChange, input.desired.content)
      )
        conflict('The exact approved proposal wording or version changed.')
      if (
        proposal.packageHandoff ||
        proposal.operationalUpdateHandoff ||
        proposal.universalContentHandoff ||
        proposal.legacyContentAdoption ||
        proposal.conflictResolutions.length
      )
        conflict('The proposal already has another content or resolution outcome.')
      const sourceEvidence = await resolveSupportProposalContentEvidence({
        db: tx,
        ...where,
        proposalId: input.proposalId,
      })
      const previewInput = {
        db: tx,
        ...where,
        proposalId: input.proposalId,
        expectedUpdatedAt: proposal.updatedAt,
        relation: input.relation,
        desired: input.desired,
      }
      const preview = await previewSemanticVenueUpdateFromProposal(previewInput)
      if (
        preview.classification !== 'DUPLICATE_NOOP' ||
        !preview.duplicateMatch ||
        preview.previewHash !== input.expectedPreviewHash ||
        preview.blockers.length ||
        preview.operationCount !== 0
      )
        conflict('Recompute the exact duplicate preview before recording this decision.')
      const targetId = preview.duplicateMatch!.knowledgeEntryId
      await tx.$queryRaw`SELECT id FROM venue_knowledge_entries WHERE id=${targetId} AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR SHARE`
      const target = await tx.venueKnowledgeEntry.findFirst({
        where: { ...where, id: targetId },
        select: {
          id: true,
          title: true,
          category: true,
          content: true,
          isEnabled: true,
          humanConfirmedAt: true,
          authorship: true,
          sourceType: true,
        },
      })
      if (!target || !target.isEnabled) conflict('The matched canonical guidance is unavailable.')
      const lockedPreview = await previewSemanticVenueUpdateFromProposal(previewInput)
      if (
        lockedPreview.previewHash !== preview.previewHash ||
        lockedPreview.duplicateMatch?.knowledgeEntryId !== targetId
      )
        conflict('Canonical duplicate evidence changed while recording the decision.')
      await tx.semanticDuplicateResolution.create({
        data: {
          id: input.operationId,
          ...where,
          proposalId: proposal.id,
          proposalUpdatedAt: proposal.updatedAt,
          previewHash: preview.previewHash,
          targetKnowledgeEntryId: targetId,
          targetSnapshotHash: hashSemanticConflictTarget(target!),
          inputHash,
          relation: input.relation,
          desired: input.desired,
          sourceEvidence,
          resolutionNote: input.resolutionNote,
          createdBy: params.actorId,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'knowledge-proposal.semantic-duplicate-resolved',
          targetType: 'SemanticDuplicateResolution',
          targetId: input.operationId,
          afterState: {
            venueId: input.venueId,
            proposalId: proposal.id,
            targetKnowledgeEntryId: targetId,
            previewHash: preview.previewHash,
            outcome: 'DUPLICATE_NOOP',
            canonicalKnowledgeChanged: false,
            approvalGranted: false,
            completionGranted: false,
          },
        },
        tx,
      )
      return result(input.operationId, false)
    })
    .catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
        conflict('Duplicate decision operation or proposal is already used.')
      throw error
    })
}
