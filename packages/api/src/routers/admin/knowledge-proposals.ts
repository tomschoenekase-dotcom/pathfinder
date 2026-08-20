import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  publishOperationalEvent,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

export const adminKnowledgeProposalsRouter = router({
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
            observedVisitorClaim: true,
            aiInference: true,
            proposedChange: true,
            reason: true,
            confidence: true,
            evidenceMessageIds: true,
            targetKnowledgeEntryId: true,
            conversationInsightId: true,
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
              select: { id: true, status: true },
            })
            if (existing) return { ...existing, replayed: true }
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
