import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { lockVenueContentMutation, writeAuditLogStrict } from '@pathfinder/db'
import type { TRPCContext } from '../context'
import { SemanticReviewedDeclineInput } from './semantic-reviewed-decline-contract'
import { resolveSupportProposalContentEvidence } from './support-proposal-content-evidence'

const conflict = (message: string): never => {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function hashInput(input: object, actorId: string) {
  return createHash('sha256')
    .update(JSON.stringify({ ...input, actorId }))
    .digest('hex')
}

function sourceMetadata(proposal: {
  id: string
  supportRequestId: string | null
  supportRequestVersion: number | null
  producedByConflictResolution: {
    proposalId: string
    proposal: {
      id: string
      supportRequestId: string | null
      supportRequestVersion: number | null
      producedByConflictResolution: { id: string } | null
    } | null
  } | null
}) {
  if (proposal.supportRequestId !== null && proposal.supportRequestVersion !== null) {
    if (proposal.producedByConflictResolution)
      conflict('A replacement proposal must freeze its original support source.')
    return {
      sourceProposalId: proposal.id,
      supportRequestId: proposal.supportRequestId,
      supportRequestVersion: proposal.supportRequestVersion,
    }
  }
  const replacement = proposal.producedByConflictResolution
  const original = replacement?.proposal
  if (!replacement || !original)
    return conflict('The proposal does not have one exact immutable support source.')
  if (
    replacement.proposalId !== original.id ||
    original.supportRequestId === null ||
    original.supportRequestVersion === null ||
    original.producedByConflictResolution
  )
    return conflict('The proposal does not have one exact immutable support source.')
  return {
    sourceProposalId: original.id,
    supportRequestId: original.supportRequestId,
    supportRequestVersion: original.supportRequestVersion,
  }
}

/** Records an immutable, source-bound human decline. It does not alter canonical content. */
export async function createSemanticReviewedDeclineService(params: {
  db: TRPCContext['db']
  actorId: string
  input: unknown
}) {
  const input = SemanticReviewedDeclineInput.parse(params.input)
  if (!params.actorId.trim()) throw new TRPCError({ code: 'FORBIDDEN' })
  const inputHash = hashInput(input, params.actorId)
  const reviewNoteHash = createHash('sha256').update(input.resolutionNote).digest('hex')
  const result = (id: string, replayed: boolean) => ({
    resolutionId: id,
    outcome: 'REVIEWED_DECLINE' as const,
    replayed,
    canonicalKnowledgeChanged: false as const,
    approvalGranted: false as const,
    completionGranted: false as const,
    currentFulfillmentVerified: false as const,
  })

  return params.db
    .$transaction(async (rawTx) => {
      const tx = rawTx as unknown as TRPCContext['db']
      await lockVenueContentMutation(tx, input)
      const where = { tenantId: input.tenantId, venueId: input.venueId }
      const existing = await tx.semanticReviewedDecline.findFirst({
        where: { ...where, id: input.operationId },
        select: { id: true, inputHash: true },
      })
      if (existing) {
        if (existing.inputHash !== inputHash)
          conflict('Reviewed decline operation is bound to another input or reviewer.')
        return result(existing.id, true)
      }
      const prior = await tx.semanticReviewedDecline.findFirst({
        where: { ...where, proposalId: input.proposalId },
        select: { id: true },
      })
      if (prior) conflict('This proposal already has an immutable reviewed decline.')

      await tx.$queryRaw`SELECT id FROM knowledge_change_proposals WHERE id=${input.proposalId}::uuid AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR UPDATE`
      const proposal = await tx.knowledgeChangeProposal.findFirst({
        where: { ...where, id: input.proposalId },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          supportRequestId: true,
          supportRequestVersion: true,
          producedByConflictResolution: {
            select: {
              proposalId: true,
              proposal: {
                select: {
                  id: true,
                  supportRequestId: true,
                  supportRequestVersion: true,
                  producedByConflictResolution: { select: { id: true } },
                },
              },
            },
          },
          packageHandoff: { select: { proposalId: true } },
          operationalUpdateHandoff: { select: { id: true } },
          universalContentHandoff: { select: { id: true } },
          legacyContentAdoption: { select: { id: true } },
          conflictResolutions: { select: { id: true }, take: 1 },
          duplicateResolution: { select: { id: true } },
        },
      })
      if (!proposal)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
      if (proposal.status !== 'PENDING_REVIEW' && proposal.status !== 'REJECTED')
        conflict('Only pending or already rejected proposals can be explicitly declined.')
      if (proposal.updatedAt.toISOString() !== input.expectedProposalUpdatedAt)
        conflict('The proposal version changed; refresh before recording the decline.')
      if (
        proposal.packageHandoff ||
        proposal.operationalUpdateHandoff ||
        proposal.universalContentHandoff ||
        proposal.legacyContentAdoption ||
        proposal.conflictResolutions.length ||
        proposal.duplicateResolution
      )
        conflict('The proposal already has another content or resolution outcome.')

      const source = sourceMetadata(proposal)
      const sourceEvidence = await resolveSupportProposalContentEvidence({
        db: tx,
        ...where,
        proposalId: proposal.id,
      })
      const reviewedAt = new Date()
      const updated = await tx.knowledgeChangeProposal.updateMany({
        where: {
          ...where,
          id: proposal.id,
          updatedAt: proposal.updatedAt,
          status: proposal.status,
        },
        data: {
          status: 'REJECTED',
          reviewerId: params.actorId,
          reviewNote: input.resolutionNote,
          reviewedAt,
        },
      })
      if (updated.count !== 1) conflict('The proposal changed while recording the decline.')
      const reviewed = await tx.knowledgeChangeProposal.findFirst({
        where: {
          ...where,
          id: proposal.id,
          status: 'REJECTED',
          reviewerId: params.actorId,
          reviewNote: input.resolutionNote,
          reviewedAt,
        },
        select: { updatedAt: true },
      })
      if (!reviewed) return conflict('The proposal review could not be verified.')

      await tx.semanticReviewedDecline.create({
        data: {
          id: input.operationId,
          ...where,
          proposalId: proposal.id,
          ...source,
          proposalUpdatedAt: proposal.updatedAt,
          reviewedProposalUpdatedAt: reviewed.updatedAt,
          reviewedAt,
          reviewNoteHash,
          inputHash,
          sourceEvidence,
          createdBy: params.actorId,
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'knowledge-proposal.semantic-reviewed-decline-recorded',
          targetType: 'SemanticReviewedDecline',
          targetId: input.operationId,
          beforeState: {
            proposalId: proposal.id,
            proposalStatus: proposal.status,
            proposalUpdatedAt: proposal.updatedAt.toISOString(),
          },
          afterState: {
            venueId: input.venueId,
            proposalId: proposal.id,
            sourceProposalId: source.sourceProposalId,
            supportRequestId: source.supportRequestId,
            supportRequestVersion: source.supportRequestVersion,
            outcome: 'REVIEWED_DECLINE',
            canonicalKnowledgeChanged: false,
            approvalGranted: false,
            completionGranted: false,
            currentFulfillmentVerified: false,
          },
        },
        tx,
      )
      return result(input.operationId, false)
    })
    .catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
        conflict('Reviewed decline operation or proposal is already used.')
      throw error
    })
}
