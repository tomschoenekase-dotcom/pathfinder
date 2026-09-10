import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { CreateLegacyKnowledgeAdoptionDraftInput } from '@pathfinder/contracts/legacy-knowledge-adoption'
import {
  CreateSemanticUniversalContentDraftInput,
  type GeneralizedContentPayload,
} from '@pathfinder/contracts/universal-content-actions'

import { router } from '../../core'
import { createLegacyKnowledgeAdoptionDraftService } from '../../lib/legacy-knowledge-adoption-service'
import {
  LegacyKnowledgeAdoptionPreparationInput,
  prepareLegacyKnowledgeAdoptionDraftService,
} from '../../lib/legacy-knowledge-adoption-preparation'
import { createSemanticUniversalContentDraftService } from '../../lib/semantic-universal-content-handoff-service'
import { resolveSupportProposalContentEvidence } from '../../lib/support-proposal-content-evidence'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import { adminProcedure } from '../../trpc'

function matchesApprovedWording(
  payload: GeneralizedContentPayload,
  desired: { title: string; content: string },
) {
  switch (payload.kind) {
    case 'POLICY':
      return payload.title === desired.title && payload.rule === desired.content
    case 'ITEM':
    case 'SERVICE':
    case 'EVENT':
      return payload.name === desired.title && payload.description === desired.content
    case 'OPERATIONAL_FACT':
      return payload.label === desired.title && payload.value === desired.content
    case 'RELATIONSHIP':
      return false
  }
}

const AdminCreateLegacyKnowledgeAdoptionDraftInput =
  CreateLegacyKnowledgeAdoptionDraftInput.superRefine((input, context) => {
    if (!input.desired.isEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desired', 'isEnabled'],
        message: 'Disabling legacy guidance requires a separate retirement workflow.',
      })
    }
    if (!matchesApprovedWording(input.draft.payload, input.desired)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draft', 'payload'],
        message: 'Draft payload text must exactly match the approved semantic change.',
      })
    }
  })

const AdminCreateSupportLegacyKnowledgeAdoptionDraftInput =
  AdminCreateLegacyKnowledgeAdoptionDraftInput.superRefine((input, context) => {
    if (input.draft.evidence.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draft', 'evidence'],
        message: 'Support adoption evidence is resolved from the retained proposal.',
      })
    }
  })

const AdminCreateSupportSemanticUniversalContentDraftInput =
  CreateSemanticUniversalContentDraftInput.extend({
    desired: SemanticUpdaterDesiredKnowledge,
  }).superRefine((input, context) => {
    if (!input.desired.isEnabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['desired', 'isEnabled'],
        message: 'Disabling guidance requires a separate retirement workflow.',
      })
    }
    if (!matchesApprovedWording(input.draft.payload, input.desired)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draft', 'payload'],
        message: 'Draft payload text must exactly match the approved semantic change.',
      })
    }
    if (input.draft.evidence.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draft', 'evidence'],
        message: 'Support evidence is resolved from the retained proposal.',
      })
    }
  })

export const adminKnowledgeProposalContentDraftRouter = router({
  prepareLegacyKnowledgeAdoptionDraft: adminProcedure
    .input(LegacyKnowledgeAdoptionPreparationInput)
    .query(({ ctx, input }) => prepareLegacyKnowledgeAdoptionDraftService({ db: ctx.db, input })),
  createLegacyKnowledgeAdoptionDraft: adminProcedure
    .input(AdminCreateLegacyKnowledgeAdoptionDraftInput)
    .mutation(async ({ ctx, input }) => {
      const result = await createLegacyKnowledgeAdoptionDraftService({
        db: ctx.db,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input,
      })
      return {
        moduleId: result.moduleId,
        revisionId: result.revisionId,
        version: result.version,
        draftHash: result.draftHash,
        legacySnapshotHash: result.legacySnapshotHash,
        replayed: result.replayed,
        requiresExplicitPublication: true as const,
        autoPublished: false as const,
      }
    }),
  createSupportLegacyKnowledgeAdoptionDraft: adminProcedure
    .input(AdminCreateSupportLegacyKnowledgeAdoptionDraftInput)
    .mutation(async ({ ctx, input }) => {
      const evidence = await resolveSupportProposalContentEvidence({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
      })
      const result = await createLegacyKnowledgeAdoptionDraftService({
        db: ctx.db,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: { ...input, draft: { ...input.draft, evidence } },
      })
      return {
        moduleId: result.moduleId,
        revisionId: result.revisionId,
        version: result.version,
        draftHash: result.draftHash,
        legacySnapshotHash: result.legacySnapshotHash,
        replayed: result.replayed,
        requiresExplicitPublication: true as const,
        autoPublished: false as const,
      }
    }),
  createSemanticUniversalContentDraft: adminProcedure
    .input(
      CreateSemanticUniversalContentDraftInput.extend({ desired: SemanticUpdaterDesiredKnowledge }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await createSemanticUniversalContentDraftService({
        db: ctx.db,
        actorId: ctx.session.userId,
        input,
      })
      return {
        moduleId: result.moduleId,
        revisionId: result.revisionId,
        version: result.version,
        classification: result.classification,
        draftHash: result.draftHash,
        replayed: result.replayed,
        requiresExplicitPublication: true as const,
        autoPublished: false as const,
      }
    }),
  createSupportSemanticUniversalContentDraft: adminProcedure
    .input(AdminCreateSupportSemanticUniversalContentDraftInput)
    .mutation(async ({ ctx, input }) => {
      const adoption = await ctx.db.legacyKnowledgeUniversalContentAdoption.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          proposalId: input.proposalId,
        },
        select: { id: true },
      })
      if (adoption) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This proposal already produced an adoption draft; review that revision.',
        })
      }
      const evidence = await resolveSupportProposalContentEvidence({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
      })
      const result = await createSemanticUniversalContentDraftService({
        db: ctx.db,
        actorId: ctx.session.userId,
        atomicPrecondition: async (tx) => {
          const currentAdoption = await tx.legacyKnowledgeUniversalContentAdoption.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              proposalId: input.proposalId,
            },
            select: { id: true },
          })
          if (currentAdoption) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'This proposal already produced an adoption draft; review that revision.',
            })
          }
        },
        input: { ...input, draft: { ...input.draft, evidence } },
      })
      return {
        moduleId: result.moduleId,
        revisionId: result.revisionId,
        version: result.version,
        classification: result.classification,
        draftHash: result.draftHash,
        replayed: result.replayed,
        requiresExplicitPublication: true as const,
        autoPublished: false as const,
      }
    }),
})
