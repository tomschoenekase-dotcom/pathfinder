import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { KnowledgeProposalTemporalEvidenceReference } from '../../lib/knowledge-proposal-temporal-evidence'

import { createOperationalUpdateAction } from '@pathfinder/db'
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
import { semanticVenueUpdateDraftFinalizer } from '../../lib/semantic-venue-update-finalizer'
import { createSemanticUniversalContentDraftService } from '../../lib/semantic-universal-content-handoff-service'
import { semanticOperationalUpdateDraftFinalizer } from '../../lib/semantic-operational-update-finalizer'
import { resolveSupportProposalContentEvidence } from '../../lib/support-proposal-content-evidence'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueUpdateDraftKey,
  semanticVenueOperationalUpdateId,
  SemanticVenueUpdaterError,
} from '../../lib/semantic-venue-updater-service'
import { adminProcedure } from '../../trpc'
import { createVenuePackageDraftService } from '../venue-package'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

const SemanticOperationalUpdateDesiredKnowledge = SemanticUpdaterDesiredKnowledge.extend({
  title: z.string().trim().min(1).max(60),
  content: z.string().trim().min(1).max(300),
})

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

export const adminKnowledgeProposalDraftRouter = router({
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
      const evidence = await resolveSupportProposalContentEvidence({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
      })
      const result = await createSemanticUniversalContentDraftService({
        db: ctx.db,
        actorId: ctx.session.userId,
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
          temporalEvidence: KnowledgeProposalTemporalEvidenceReference.optional(),
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
        temporalEvidence: input.temporalEvidence,
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
})
