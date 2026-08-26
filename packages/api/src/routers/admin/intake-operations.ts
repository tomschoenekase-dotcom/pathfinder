import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeActionError,
  OnboardingBootstrapError,
  createIntakeProposal,
  getIntakeProposalReview,
  interviewProposalInput,
  notesProposalInput,
  listOnboardingBootstrapDetails,
  listIntakeProposals,
  websiteProposalInput,
} from '@pathfinder/db'

import { router } from '../../core'
import { intakeReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { getIntakeBuilderLifecycle } from '../../lib/intake-builder-lifecycle-service'
import {
  executeWebsiteIntakeResearch,
  WebsiteResearchExecutionError,
} from '../../lib/website-intake-research-service'
import { createWebsiteIntakeRuntimeDependencies } from '../../lib/website-intake-runtime'
import { createVenuePackageDraftService } from '../venue-package'
import {
  buildIntakeVenuePackageCandidate,
  isExactIntakeCandidateHandoff,
  intakeCandidateDraftKey,
  IntakeVenuePackageCandidateError,
} from '../../lib/intake-venue-package-candidate'
import { adminProcedure } from '../../trpc'
import {
  createWebsiteResearchClarificationQuestions,
  WebsiteClarificationError,
} from '../../lib/intake-website-clarifications'
import {
  buildWebsiteVenuePackageMappingCandidate,
  WebsiteMappingError,
  WebsiteMappingSelections,
  websiteMappingDraftKey,
} from '../../lib/intake-website-mapping'

const adminScope = { tenantId: z.string().min(1), venueId: z.string().min(1) }
const createInput = z.discriminatedUnion('kind', [
  websiteProposalInput.extend({ ...adminScope, requestId: z.string().uuid() }).strict(),
  interviewProposalInput.extend({ ...adminScope, requestId: z.string().uuid() }).strict(),
  notesProposalInput.extend({ ...adminScope, requestId: z.string().uuid() }).strict(),
])

function mapActionError(error: unknown): never {
  if (error instanceof IntakeActionError || error instanceof OnboardingBootstrapError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'NOT_FOUND',
      message: error.message,
    })
  }
  throw error
}

function mapCandidateError(error: unknown): never {
  if (error instanceof IntakeVenuePackageCandidateError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'PRECONDITION_FAILED',
      message: error.message,
    })
  }
  mapActionError(error)
}

export const adminIntakeOperationsRouter = router({
  executeWebsiteIntakeResearch: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
          operationId: z.string().uuid(),
          priorReceiptId: z.string().uuid().optional(),
          maxPages: z.number().int().min(1).max(10).default(5),
          maxDepth: z.number().int().min(0).max(2).default(1),
          maxBytesPerPage: z.number().int().min(1).max(2_000_000).default(1_000_000),
          maxDurationMs: z.number().int().min(1_000).max(60_000).default(30_000),
          maxCostUnits: z.number().int().min(1).max(100).default(20),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const userAgent = 'TorchikoBuilder/1.0'
      const { priorReceiptId, ...researchInput } = input
      try {
        return await executeWebsiteIntakeResearch({
          db: ctx.db,
          request: {
            ...researchInput,
            ...(priorReceiptId ? { priorReceiptId } : {}),
            userAgent,
            createdBy: ctx.session.userId,
          },
          dependencies: createWebsiteIntakeRuntimeDependencies({ userAgent }),
        })
      } catch (error) {
        if (error instanceof WebsiteResearchExecutionError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),

  getIntakeBuilderLifecycle: adminProcedure
    .input(z.object({ ...adminScope, runId: z.string().trim().min(1).max(191) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeBuilderLifecycle({ db: ctx.db, ...input })
      } catch (error) {
        mapCandidateError(error)
      }
    }),

  createWebsiteResearchClarificationQuestions: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          expectedResearchHash: z.string().regex(/^[a-f0-9]{64}$/u),
          discrepancyIds: z.array(z.string().trim().min(1).max(191)).min(1).max(20),
          agentIdentityId: z.string().trim().min(1).max(191),
        })
        .strict()
        .superRefine((value, context) => {
          if (new Set(value.discrepancyIds).size !== value.discrepancyIds.length) {
            context.addIssue({
              code: 'custom',
              path: ['discrepancyIds'],
              message: 'Discrepancy selections must be unique.',
            })
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createWebsiteResearchClarificationQuestions({ db: ctx.db, ...input })
      } catch (error) {
        if (error instanceof WebsiteClarificationError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),

  previewWebsiteVenuePackageMapping: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          expectedResearchHash: z.string().regex(/^[a-f0-9]{64}$/u),
          selections: WebsiteMappingSelections,
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await buildWebsiteVenuePackageMappingCandidate({ db: ctx.db, ...input })
      } catch (error) {
        if (error instanceof WebsiteMappingError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),

  createAndLinkWebsiteMappingDraft: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          expectedResearchHash: z.string().regex(/^[a-f0-9]{64}$/u),
          expectedMappingReviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/u),
          selections: WebsiteMappingSelections,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      let candidate
      try {
        candidate = await buildWebsiteVenuePackageMappingCandidate({
          db: ctx.db,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          receiptId: input.receiptId,
          expectedResearchHash: input.expectedResearchHash,
          selections: input.selections,
          allowExistingHandoff: true,
        })
      } catch (error) {
        if (error instanceof WebsiteMappingError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'CONFLICT'
                    ? 'CONFLICT'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
      if (
        candidate.mappingReviewHash !== input.expectedMappingReviewHash ||
        candidate.candidateHash !== input.expectedCandidateHash
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Website mapping evidence changed; preview it again before creating a draft.',
        })
      }
      const draftKey = websiteMappingDraftKey({
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        mappingReviewHash: candidate.mappingReviewHash,
        actorId: ctx.session.userId,
      })
      const existingHandoff = await isExactIntakeCandidateHandoff({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        draftKey,
        candidateHash: candidate.candidateHash,
        actorId: ctx.session.userId,
      })
      if (existingHandoff === 'MISMATCH') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This website intake is already linked to a different package draft.',
        })
      }
      const baseFinalizer = intakeReviewedDraftFinalizer({
        actorId: ctx.session.userId,
        intakeRunId: input.runId,
      })
      const mappingReviewHash = candidate.mappingReviewHash
      const candidateHash = candidate.candidateHash
      return createVenuePackageDraftService({
        db: ctx.db,
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: { venueId: input.venueId, draftKey, payload: candidate.payload },
        finalizer: async (finalizerInput) => {
          const current = await buildWebsiteVenuePackageMappingCandidate({
            db: finalizerInput.tx,
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.runId,
            receiptId: input.receiptId,
            expectedResearchHash: input.expectedResearchHash,
            selections: input.selections,
            allowExistingHandoff: true,
          })
          if (
            current.mappingReviewHash !== mappingReviewHash ||
            current.candidateHash !== candidateHash
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Website mapping evidence changed during draft creation.',
            })
          }
          return baseFinalizer(finalizerInput)
        },
      })
    }),

  getIntakeVenuePackageCandidate: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await buildIntakeVenuePackageCandidate({ db: ctx.db, ...input })
      } catch (error) {
        mapCandidateError(error)
      }
    }),

  createAndLinkIntakeCandidateDraft: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().trim().min(1).max(191),
          expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      let candidate
      try {
        candidate = await buildIntakeVenuePackageCandidate({
          db: ctx.db,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          allowExistingHandoff: true,
        })
      } catch (error) {
        mapCandidateError(error)
      }
      if (!candidate.ready || !candidate.payload || !candidate.candidateHash) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The reviewed intake source is not ready for a package candidate.',
        })
      }
      if (candidate.candidateHash !== input.expectedCandidateHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The reviewed intake candidate changed. Reload it before creating a draft.',
        })
      }
      const canonicalHash = candidate.candidateHash
      const draftKey = intakeCandidateDraftKey({
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        candidateHash: canonicalHash,
        actorId: ctx.session.userId,
      })
      const existingHandoff = await isExactIntakeCandidateHandoff({
        db: ctx.db,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        draftKey,
        candidateHash: canonicalHash,
        actorId: ctx.session.userId,
      })
      if (existingHandoff === 'MISMATCH') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This intake proposal is already linked to a different package draft.',
        })
      }
      const baseFinalizer = intakeReviewedDraftFinalizer({
        actorId: ctx.session.userId,
        intakeRunId: input.runId,
      })
      return createVenuePackageDraftService({
        db: ctx.db,
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        input: {
          venueId: input.venueId,
          draftKey,
          payload: candidate.payload,
        },
        finalizer: async (finalizerInput) => {
          const current = await buildIntakeVenuePackageCandidate({
            db: finalizerInput.tx,
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.runId,
            allowExistingHandoff: true,
          })
          if (!current.ready || !current.payload || current.candidateHash !== canonicalHash) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'The reviewed intake candidate changed during draft creation.',
            })
          }
          return baseFinalizer(finalizerInput)
        },
      })
    }),

  listOnboardingBootstrapDetails: adminProcedure
    .input(
      z.object({ ...adminScope, limit: z.number().int().min(1).max(100).default(25) }).strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listOnboardingBootstrapDetails({ client: ctx.db, ...input })
      } catch (error) {
        mapActionError(error)
      }
    }),

  listIntakeProposals: adminProcedure
    .input(
      z.object({ ...adminScope, limit: z.number().int().min(1).max(100).default(25) }).strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listIntakeProposals({ db: ctx.db, ...input })
      } catch (error) {
        mapActionError(error)
      }
    }),

  getIntakeProposalReview: adminProcedure
    .input(z.object({ ...adminScope, runId: z.string().trim().min(1).max(191) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeProposalReview({ db: ctx.db, ...input })
      } catch (error) {
        mapActionError(error)
      }
    }),

  createIntakeProposal: adminProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const { tenantId, venueId, requestId, ...proposal } = input
    try {
      return await createIntakeProposal({
        db: ctx.db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        requestId,
        proposal,
      })
    } catch (error) {
      mapActionError(error)
    }
  }),
})
