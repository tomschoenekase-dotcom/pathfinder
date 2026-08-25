import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  publishOperationalEvent,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { adminSupportCorrectionProposalsRouter } from './support-knowledge-proposals'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

const adminKnowledgeProposalReviewRouter = router({
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
      withTenantIsolationBypass(() =>
        db.knowledgeChangeProposal.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.status ? { status: input.status } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: {
            id: true,
            status: true,
            sessionId: true,
            observedVisitorClaim: true,
            aiInference: true,
            proposedChange: true,
            reason: true,
            confidence: true,
            evidenceMessageIds: true,
            targetKnowledgeEntryId: true,
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
        }),
      ),
    ),

  createKnowledgeProposal: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          ...scope,
          conversationInsightId: z.string().uuid().optional(),
          targetKnowledgeEntryId: z.string().min(1).max(191).optional(),
          observedVisitorClaim: z.string().trim().min(1).max(2000).optional(),
          aiInference: z.string().trim().min(1).max(2000).optional(),
          proposedChange: z.string().trim().min(1).max(10000),
          reason: z.string().trim().min(1).max(2000),
          confidence: z.number().min(0).max(1),
          evidenceMessageIds: z.array(z.string().min(1).max(191)).max(20).default([]),
          submitForReview: z.boolean().default(true),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const id = input.operationId
        return db
          .$transaction(async (tx) => {
            const existing = await tx.knowledgeChangeProposal.findFirst({
              where: { id, tenantId: input.tenantId, venueId: input.venueId },
              select: {
                id: true,
                status: true,
                conversationInsightId: true,
                supportRequestId: true,
                supportRequestVersion: true,
                targetKnowledgeEntryId: true,
                observedVisitorClaim: true,
                aiInference: true,
                proposedChange: true,
                reason: true,
                confidence: true,
                evidenceMessageIds: true,
              },
            })
            if (existing) {
              const exactReplay =
                existing.conversationInsightId === (input.conversationInsightId ?? null) &&
                existing.supportRequestId === null &&
                existing.supportRequestVersion === null &&
                existing.targetKnowledgeEntryId === (input.targetKnowledgeEntryId ?? null) &&
                existing.observedVisitorClaim === (input.observedVisitorClaim ?? null) &&
                existing.aiInference === (input.aiInference ?? null) &&
                existing.proposedChange === input.proposedChange &&
                existing.reason === input.reason &&
                Number(existing.confidence) === input.confidence &&
                JSON.stringify(existing.evidenceMessageIds) ===
                  JSON.stringify(input.evidenceMessageIds)
              if (!exactReplay)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Operation ID is already bound to a different proposal.',
                })
              return { id: existing.id, status: existing.status, replayed: true }
            }
            if (input.conversationInsightId) {
              const insight = await tx.conversationInsight.findFirst({
                where: {
                  id: input.conversationInsightId,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                },
                select: { id: true, sessionId: true },
              })
              if (!insight)
                throw new TRPCError({
                  code: 'NOT_FOUND',
                  message: 'Conversation insight not found.',
                })
              const active = await tx.knowledgeChangeProposal.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  conversationInsightId: input.conversationInsightId,
                  status: { in: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED'] },
                },
                select: { id: true },
              })
              if (active)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'This conversation insight already has an active proposal.',
                })
            }
            if (input.targetKnowledgeEntryId) {
              const target = await tx.venueKnowledgeEntry.findFirst({
                where: {
                  id: input.targetKnowledgeEntryId,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                },
                select: { id: true },
              })
              if (!target)
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Knowledge entry not found.' })
            }
            const insight = input.conversationInsightId
              ? await tx.conversationInsight.findFirst({
                  where: {
                    id: input.conversationInsightId,
                    tenantId: input.tenantId,
                    venueId: input.venueId,
                  },
                  select: { sessionId: true },
                })
              : null
            const created = await tx.knowledgeChangeProposal.create({
              data: {
                id,
                tenantId: input.tenantId,
                venueId: input.venueId,
                ...(insight && input.conversationInsightId
                  ? {
                      sessionId: insight.sessionId,
                      conversationInsightId: input.conversationInsightId,
                    }
                  : {}),
                ...(input.targetKnowledgeEntryId
                  ? { targetKnowledgeEntryId: input.targetKnowledgeEntryId }
                  : {}),
                ...(input.observedVisitorClaim
                  ? { observedVisitorClaim: input.observedVisitorClaim }
                  : {}),
                ...(input.aiInference ? { aiInference: input.aiInference } : {}),
                proposedChange: input.proposedChange,
                reason: input.reason,
                confidence: input.confidence,
                evidenceMessageIds: input.evidenceMessageIds,
                status: input.submitForReview ? 'PENDING_REVIEW' : 'DRAFT',
                createdByType: 'HUMAN',
                createdById: ctx.session.userId,
              },
              select: { id: true, status: true },
            })
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'knowledge-proposal.created',
                targetType: 'KnowledgeChangeProposal',
                targetId: created.id,
                afterState: {
                  venueId: input.venueId,
                  status: created.status,
                  hasConversationEvidence: Boolean(input.conversationInsightId),
                },
              },
              tx,
            )
            return { ...created, replayed: false }
          })
          .then(async (result) => {
            if (result.status === 'PENDING_REVIEW') {
              await publishOperationalEvent({
                client: db,
                event: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  eventType: 'knowledge.proposal.created',
                  sourceSubsystem: 'knowledge-improvement',
                  severity: 'WARNING',
                  title: 'Knowledge change proposal needs review',
                  summary:
                    'A proposed change is waiting for human verification before it can affect canonical venue knowledge.',
                  actionRequired: true,
                  linkedObjectType: 'knowledge-change-proposal',
                  linkedObjectId: result.id,
                  recommendedAction:
                    'Compare the proposal with trusted venue evidence, then approve or reject it.',
                  deduplicationKey: `knowledge-proposal:${result.id}`,
                },
              }).catch(() => undefined)
            }
            return result
          })
          .catch((error: unknown) => {
            if (isUniqueConflict(error))
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'This conversation insight already has an active proposal.',
              })
            throw error
          })
      }),
    ),

  reviewKnowledgeProposal: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.string().datetime(),
          decision: z.enum(['APPROVED', 'REJECTED']),
          reviewNote: z.string().trim().min(1).max(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const updated = await tx.knowledgeChangeProposal.updateMany({
            where: {
              id: input.proposalId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: 'PENDING_REVIEW',
              updatedAt: new Date(input.expectedUpdatedAt),
            },
            data: {
              status: input.decision,
              reviewerId: ctx.session.userId,
              reviewNote: input.reviewNote,
              reviewedAt: new Date(),
            },
          })
          if (updated.count !== 1)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Proposal changed; refresh before reviewing.',
            })
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'knowledge-proposal.reviewed',
              targetType: 'KnowledgeChangeProposal',
              targetId: input.proposalId,
              beforeState: { status: 'PENDING_REVIEW' },
              afterState: { status: input.decision, operationId: input.operationId },
            },
            tx,
          )
          return {
            proposalId: input.proposalId,
            status: input.decision,
            canonicalKnowledgeChanged: false as const,
          }
        }),
      ),
    ),
})

export const adminKnowledgeProposalsRouter = mergeRouters(
  adminKnowledgeProposalReviewRouter,
  adminSupportCorrectionProposalsRouter,
)
