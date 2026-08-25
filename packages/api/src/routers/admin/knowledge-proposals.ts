import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  createOperationalUpdateAction,
  db,
  publishOperationalEvent,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { semanticVenueUpdateDraftFinalizer } from '../../lib/semantic-venue-update-finalizer'
import { semanticOperationalUpdateDraftFinalizer } from '../../lib/semantic-operational-update-finalizer'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueUpdateDraftKey,
  semanticVenueOperationalUpdateId,
  SemanticVenueUpdaterError,
} from '../../lib/semantic-venue-updater-service'
import { adminProcedure } from '../../trpc'
import { createVenuePackageDraftService } from '../venue-package'
import { adminSupportCorrectionProposalsRouter } from './support-knowledge-proposals'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

const SemanticOperationalUpdateDesiredKnowledge = SemanticUpdaterDesiredKnowledge.extend({
  title: z.string().trim().min(1).max(60),
  content: z.string().trim().min(1).max(300),
})

const operationalUpdateHandoffSelect = {
  previewHash: true,
  operationalUpdate: {
    select: {
      id: true,
      status: true,
      isActive: true,
      updateType: true,
      severity: true,
      priority: true,
      title: true,
      body: true,
      startsAt: true,
      expiresAt: true,
    },
  },
} as const

function exactOperationalDraftFromHandoff(
  existing: {
    previewHash: string
    operationalUpdate: {
      id: string
      status: string
      isActive: boolean
      updateType: string
      severity: string
      priority: string
      title: string
      body: string | null
      startsAt: Date
      expiresAt: Date
    }
  } | null,
  draft: {
    updateType: string
    severity: string
    priority: string
    title: string
    body: string
    startsAt: string
    expiresAt: string
  },
  previewHash: string,
) {
  const update = existing?.operationalUpdate
  if (
    !existing ||
    !update ||
    existing.previewHash !== previewHash ||
    update.status !== 'DRAFT' ||
    update.isActive ||
    update.updateType !== draft.updateType ||
    update.severity !== draft.severity ||
    update.priority !== draft.priority ||
    update.title !== draft.title ||
    update.body !== draft.body ||
    update.startsAt.toISOString() !== draft.startsAt ||
    update.expiresAt.toISOString() !== draft.expiresAt
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The existing temporal handoff no longer matches this exact DRAFT.',
    })
  }
  return update
}

const adminKnowledgeProposalReviewRouter = router({
  createSemanticOperationalUpdateDraft: adminProcedure
    .input(
      z
        .object({
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
          desired: SemanticOperationalUpdateDesiredKnowledge,
          validFrom: z.string().datetime(),
          validUntil: z.string().datetime(),
          operationalUpdateType: z.enum([
            'GENERAL_NOTICE',
            'TEMPORARY_CLOSURE',
            'UNAVAILABLE_EXHIBIT',
            'CHANGED_HOURS',
            'MAINTENANCE',
            'SPECIAL_EVENT',
            'SOLD_OUT_ACTIVITY',
            'TEMPORARY_VENDOR_LOCATION',
          ]),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const previewInput = {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        relation: input.relation,
        desired: input.desired,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        operationalUpdateType: input.operationalUpdateType,
      }
      let preview
      try {
        preview = await previewSemanticVenueUpdateFromProposal({ db: ctx.db, ...previewInput })
      } catch (error) {
        if (error instanceof SemanticVenueUpdaterError) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
      if (preview.proposalStatus !== 'APPROVED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Human evidence approval is required before creating an update DRAFT.',
        })
      }
      if (preview.previewHash !== input.expectedPreviewHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Semantic preview changed; recompute it before creating an update DRAFT.',
        })
      }
      const draft = preview.operationalUpdateDraft
      if (!draft) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This semantic preview does not contain a temporal update.',
        })
      }

      const existing = await ctx.db.knowledgeProposalOperationalUpdateHandoff.findFirst({
        where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
        select: operationalUpdateHandoffSelect,
      })
      if (existing) {
        const update = exactOperationalDraftFromHandoff(existing, draft, preview.previewHash)
        return {
          operationalUpdateId: update.id,
          operationalUpdateStatus: update.status,
          replayed: true as const,
          previewHash: preview.previewHash,
          classification: preview.classification,
          autoScheduled: false as const,
          autoPublished: false as const,
        }
      }

      let created
      try {
        created = await createOperationalUpdateAction(
          {
            tenantId: input.tenantId,
            id: semanticVenueOperationalUpdateId({
              tenantId: input.tenantId,
              venueId: input.venueId,
              proposalId: input.proposalId,
              previewHash: preview.previewHash,
            }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            fields: {
              venueId: input.venueId,
              updateType: draft.updateType,
              severity: draft.severity,
              priority: draft.priority,
              title: draft.title,
              body: draft.body,
              startsAt: new Date(draft.startsAt),
              expiresAt: new Date(draft.expiresAt),
            },
            schedule: false,
            finalizer: semanticOperationalUpdateDraftFinalizer({
              actorId: ctx.session.userId,
              expectedPreviewHash: preview.previewHash,
              previewInput,
            }),
          },
          ctx.db,
        )
      } catch (error) {
        if (!isUniqueConflict(error)) throw error
        const raced = await ctx.db.knowledgeProposalOperationalUpdateHandoff.findFirst({
          where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
          select: operationalUpdateHandoffSelect,
        })
        const update = exactOperationalDraftFromHandoff(raced, draft, preview.previewHash)
        return {
          operationalUpdateId: update.id,
          operationalUpdateStatus: update.status,
          replayed: true as const,
          previewHash: preview.previewHash,
          classification: preview.classification,
          autoScheduled: false as const,
          autoPublished: false as const,
        }
      }
      return {
        operationalUpdateId: created.update.id,
        operationalUpdateStatus: created.update.status,
        replayed: false as const,
        previewHash: preview.previewHash,
        classification: preview.classification,
        autoScheduled: false as const,
        autoPublished: false as const,
      }
    }),

  createSemanticVenueUpdatePackageDraft: adminProcedure
    .input(
      z
        .object({
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
          desired: SemanticUpdaterDesiredKnowledge,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const previewInput = {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        relation: input.relation,
        desired: input.desired,
      }
      let preview
      try {
        preview = await previewSemanticVenueUpdateFromProposal({ db: ctx.db, ...previewInput })
      } catch (error) {
        if (error instanceof SemanticVenueUpdaterError) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
      if (preview.proposalStatus !== 'APPROVED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Human evidence approval is required before creating a package DRAFT.',
        })
      }
      if (preview.previewHash !== input.expectedPreviewHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Semantic preview changed; recompute it before creating a package DRAFT.',
        })
      }
      if (!preview.venuePackagePatch) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This semantic preview does not contain a package change.',
        })
      }
      const created = await createVenuePackageDraftService({
        db: ctx.db,
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: {
          venueId: input.venueId,
          draftKey: semanticVenueUpdateDraftKey({
            tenantId: input.tenantId,
            venueId: input.venueId,
            proposalId: input.proposalId,
            previewHash: preview.previewHash,
          }),
          payload: preview.venuePackagePatch,
        },
        finalizer: semanticVenueUpdateDraftFinalizer({
          actorId: ctx.session.userId,
          expectedPreviewHash: preview.previewHash,
          previewInput,
        }),
      })
      return {
        packageId: created.value.id,
        packageStatus: created.value.status,
        replayed: created.value.replayed,
        previewHash: preview.previewHash,
        classification: preview.classification,
        autoApproved: false as const,
        autoApplied: false as const,
        autoPublished: false as const,
      }
    }),

  previewSemanticVenueUpdate: adminProcedure
    .input(
      z
        .object({
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
          desired: SemanticUpdaterDesiredKnowledge,
          validFrom: z.string().datetime().optional(),
          validUntil: z.string().datetime().optional(),
          operationalUpdateType: z
            .enum([
              'GENERAL_NOTICE',
              'TEMPORARY_CLOSURE',
              'UNAVAILABLE_EXHIBIT',
              'CHANGED_HOURS',
              'MAINTENANCE',
              'SPECIAL_EVENT',
              'SOLD_OUT_ACTIVITY',
              'TEMPORARY_VENDOR_LOCATION',
            ])
            .optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await previewSemanticVenueUpdateFromProposal({ db: ctx.db, ...input })
      } catch (error) {
        if (error instanceof SemanticVenueUpdaterError) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),

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
