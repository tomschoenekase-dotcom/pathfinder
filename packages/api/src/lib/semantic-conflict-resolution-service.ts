import { createHash, randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { lockVenueContentMutation, writeAuditLogStrict } from '@pathfinder/db'
import type { TRPCContext } from '../context'
import {
  SemanticConflictResolutionInput,
  hashSemanticConflictAnswer,
  hashSemanticConflictTarget,
} from './semantic-conflict-resolution-contract'
import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueConflictQuestionOperationId,
} from './semantic-venue-updater-service'

const conflict = (message: string): never => {
  throw new TRPCError({ code: 'CONFLICT', message })
}

/** Human admin route only. Records adjudication; never writes canonical content or publishes. */
export async function resolveSemanticConflictService(params: {
  db: TRPCContext['db']
  actorId: string
  input: unknown
}) {
  const input = SemanticConflictResolutionInput.parse(params.input)
  if (!params.actorId.trim()) throw new TRPCError({ code: 'FORBIDDEN' })
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ ...input, actorId: params.actorId }))
    .digest('hex')
  return params.db
    .$transaction(async (rawTx) => {
      const tx = rawTx as unknown as TRPCContext['db']
      await lockVenueContentMutation(tx, input)
      const existing = await tx.semanticConflictResolution.findFirst({
        where: { id: input.operationId, tenantId: input.tenantId, venueId: input.venueId },
      })
      if (existing) {
        if (existing.inputHash !== inputHash)
          conflict('Resolution operation is already bound to another decision.')
        return {
          resolutionId: existing.id,
          replacementProposalId: existing.replacementProposalId,
          outcome: existing.outcome,
          replayed: true,
          canonicalKnowledgeChanged: false as const,
          approvalGranted: false as const,
        }
      }
      const prior = await tx.semanticConflictResolution.findFirst({
        where: { questionId: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
      })
      if (prior) conflict('This exact conflict question already has a resolution.')
      await tx.$queryRaw`SELECT id FROM knowledge_change_proposals WHERE id=${input.proposalId}::uuid AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR UPDATE`
      const proposal = await tx.knowledgeChangeProposal.findFirst({
        where: { id: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
      })
      if (!proposal)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge proposal not found.' })
      if (
        proposal.status !== 'APPROVED' ||
        proposal.updatedAt.toISOString() !== input.expectedProposalUpdatedAt ||
        !proposal.targetKnowledgeEntryId
      )
        conflict('The approved targeted proposal changed.')
      const preview = await previewSemanticVenueUpdateFromProposal({
        db: tx,
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: proposal.updatedAt,
        relation: input.relation,
        desired: input.desired,
      })
      if (
        preview.classification !== 'CONFLICT' ||
        preview.previewHash !== input.expectedPreviewHash ||
        preview.blockers.length !== 1 ||
        preview.blockers[0]?.code !== 'LOWER_AUTHORITY_CONFLICT'
      )
        conflict('Recompute the exact lower-authority conflict before resolving it.')
      await tx.$queryRaw`SELECT id FROM agent_questions WHERE id=${input.questionId} AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR SHARE`
      const question = await tx.agentQuestion.findFirst({
        where: { id: input.questionId, tenantId: input.tenantId, venueId: input.venueId },
      })
      if (
        !question ||
        question.operationId !==
          semanticVenueConflictQuestionOperationId({
            tenantId: input.tenantId,
            venueId: input.venueId,
            proposalId: input.proposalId,
            previewHash: preview.previewHash,
          }) ||
        question.status !== 'ANSWERED' ||
        !question.answer ||
        !question.answeredAt ||
        !question.answeredById ||
        question.updatedAt.toISOString() !== input.expectedQuestionUpdatedAt ||
        question.answeredAt.toISOString() !== input.expectedAnsweredAt ||
        hashSemanticConflictAnswer(question.answer) !== input.expectedAnswerHash
      )
        conflict('The exact answered conflict evidence changed.')
      await tx.$queryRaw`SELECT id FROM venue_knowledge_entries WHERE id=${proposal.targetKnowledgeEntryId} AND tenant_id=${input.tenantId} AND venue_id=${input.venueId} FOR SHARE`
      const target = await tx.venueKnowledgeEntry.findFirstOrThrow({
        where: {
          id: proposal.targetKnowledgeEntryId!,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
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
      const lockedPreview = await previewSemanticVenueUpdateFromProposal({
        db: tx,
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: proposal.updatedAt,
        relation: input.relation,
        desired: input.desired,
      })
      if (lockedPreview.previewHash !== preview.previewHash)
        conflict('Canonical evidence changed while resolving the conflict.')
      const desired =
        input.outcome === 'PROPOSE_REPLACEMENT'
          ? input.replacementDesired!
          : {
              title: target.title,
              category: target.category,
              content: target.content,
              isEnabled: target.isEnabled,
            }
      const replacementProposalId = input.outcome === 'PROPOSE_REPLACEMENT' ? randomUUID() : null
      if (replacementProposalId)
        await tx.knowledgeChangeProposal.create({
          data: {
            id: replacementProposalId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            targetKnowledgeEntryId: target.id,
            proposedChange: desired.content,
            reason: input.resolutionNote,
            confidence: proposal.confidence,
            evidenceMessageIds: proposal.evidenceMessageIds!,
            status: 'PENDING_REVIEW',
            createdByType: 'HUMAN',
            createdById: params.actorId,
          },
        })
      await tx.semanticConflictResolution.create({
        data: {
          id: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          proposalId: proposal.id,
          proposalUpdatedAt: proposal.updatedAt,
          previewHash: preview.previewHash,
          questionId: question!.id,
          questionUpdatedAt: question!.updatedAt,
          answeredAt: question!.answeredAt!,
          answerHash: input.expectedAnswerHash,
          targetKnowledgeEntryId: target.id,
          targetSnapshotHash: hashSemanticConflictTarget(target),
          inputHash,
          relation: input.relation,
          conflictDesired: input.desired,
          desired,
          outcome: input.outcome,
          resolutionNote: input.resolutionNote,
          replacementProposalId,
          createdBy: params.actorId,
        },
      })
      const retired = await tx.knowledgeChangeProposal.updateMany({
        where: {
          id: proposal.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'APPROVED',
          updatedAt: proposal.updatedAt,
        },
        data: {
          status: 'REJECTED',
          reviewerId: params.actorId,
          reviewedAt: new Date(),
          reviewNote: `Resolved by semantic conflict decision ${input.operationId}.`,
        },
      })
      if (retired.count !== 1) conflict('The original proposal changed during resolution.')
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: params.actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'knowledge-proposal.semantic-conflict-resolved',
          targetType: 'SemanticConflictResolution',
          targetId: input.operationId,
          afterState: {
            venueId: input.venueId,
            proposalId: proposal.id,
            questionId: input.questionId,
            answerHash: input.expectedAnswerHash,
            outcome: input.outcome,
            replacementProposalId,
            replacementStatus: replacementProposalId ? 'PENDING_REVIEW' : null,
            canonicalKnowledgeChanged: false,
            approvalGranted: false,
            authorityVerified: false,
          },
        },
        tx,
      )
      return {
        resolutionId: input.operationId,
        replacementProposalId,
        outcome: input.outcome,
        replayed: false,
        canonicalKnowledgeChanged: false as const,
        approvalGranted: false as const,
      }
    })
    .catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
        conflict('Resolution operation or question is already used.')
      throw error
    })
}
