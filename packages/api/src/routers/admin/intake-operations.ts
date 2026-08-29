import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { logger } from '@pathfinder/config'
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

import { mergeRouters, publicTRPCError, router } from '../../core'
import { getIntakeBuilderLifecycle } from '../../lib/intake-builder-lifecycle-service'
import {
  executeWebsiteIntakeResearch,
  WebsiteResearchExecutionError,
} from '../../lib/website-intake-research-service'
import { createWebsiteIntakeRuntimeDependencies } from '../../lib/website-intake-runtime'
import {
  buildIntakeVenuePackageCandidate,
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
} from '../../lib/intake-website-mapping'
import {
  createIntakeCandidateDraftForAdmin,
  createWebsiteMappingDraftForAdmin,
} from './intake-draft-actions'
import { adminIntakeInterviewClarificationsRouter } from './intake-interview-clarifications'
import { adminIntakeFileExtractionRouter } from './intake-file-extraction'
import { adminIntakeFileClarificationsRouter } from './intake-file-clarifications'

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

const adminIntakeOperationsCoreRouter = router({
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
          logger.warn({
            action: 'intake.website-research.rejected',
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.runId,
            errorCode: error.code,
            error: error.message,
          })
          throw publicTRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        const errorCode =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : null
        logger.error({
          action: 'intake.website-research.unhandled',
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          errorName: error instanceof Error ? error.name : 'Unknown',
          errorCode,
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Unknown website research failure',
        })
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
      try {
        return await createWebsiteMappingDraftForAdmin({
          db: ctx.db,
          actorId: ctx.session.userId,
          ...input,
        })
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error
        }
        mapCandidateError(error)
      }
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
      try {
        return await createIntakeCandidateDraftForAdmin({
          db: ctx.db,
          actorId: ctx.session.userId,
          ...input,
        })
      } catch (error) {
        mapCandidateError(error)
      }
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

export const adminIntakeOperationsRouter = mergeRouters(
  adminIntakeOperationsCoreRouter,
  adminIntakeFileClarificationsRouter,
  adminIntakeFileExtractionRouter,
  adminIntakeInterviewClarificationsRouter,
)
