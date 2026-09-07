import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { env } from '@pathfinder/config'

import {
  IntakeActionError,
  OnboardingBootstrapError,
  createIntakeProposal,
  getIntakeSubmissionDraft,
  getIntakeV1SubmissionAction,
  getLatestIntakeV1SubmissionAction,
  getIntakeV1ProcessingRead,
  IntakeSubmissionDraftError,
  IntakeV1SubmissionError,
  IntakeV1ProcessingReadError,
  getIntakeProposalReview,
  getOnboardingBootstrapSubmission,
  interviewProposalInput,
  notesProposalInput,
  listIntakeProposals,
  listIntakeV1CandidatesAction,
  listIntakeV1UploadCandidatesAction,
  saveIntakeSubmissionDraft,
  intakeSubmissionDraftContent,
  intakeV1SubmissionSelection,
  onboardingBootstrapSubmissionInput,
  submitOnboardingBootstrapAction,
  submitIntakeV1Action,
  websiteProposalInput,
} from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

const scope = z.object({ venueId: z.string().min(1) }).strict()
const createInput = z.discriminatedUnion('kind', [
  websiteProposalInput
    .extend({
      venueId: z.string().min(1),
      requestId: z.string().uuid(),
      draftRevision: z.number().int().min(1).optional(),
    })
    .strict(),
  interviewProposalInput
    .extend({
      venueId: z.string().min(1),
      requestId: z.string().uuid(),
      draftRevision: z.number().int().min(1).optional(),
    })
    .strict(),
  notesProposalInput
    .extend({
      venueId: z.string().min(1),
      requestId: z.string().uuid(),
      draftRevision: z.number().int().min(1).optional(),
    })
    .strict(),
])

function mapActionError(error: unknown): never {
  if (error instanceof IntakeSubmissionDraftError) {
    throw new TRPCError({
      code:
        error.code === 'CONFLICT'
          ? 'CONFLICT'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
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
  if (error instanceof IntakeV1SubmissionError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : error.code === 'PRECONDITION_FAILED'
              ? 'PRECONDITION_FAILED'
              : 'BAD_REQUEST',
      message: error.message,
    })
  }
  if (error instanceof IntakeV1ProcessingReadError) {
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.message,
    })
  }
  throw error
}

export const intakeRouter = router({
  getSubmissionDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().min(1),
          sourceKind: z.enum(['WEBSITE', 'INTERVIEW', 'NOTES']),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeSubmissionDraft(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            ownerUserId: ctx.session.userId,
            sourceKind: input.sourceKind,
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),
  saveSubmissionDraft: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      z
        .object({
          venueId: z.string().min(1).max(191),
          sourceKind: z.enum(['WEBSITE', 'INTERVIEW', 'NOTES']),
          content: intakeSubmissionDraftContent,
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await saveIntakeSubmissionDraft(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            ownerUserId: ctx.session.userId,
            sourceKind: input.sourceKind,
            content: input.content,
            ...(input.expectedRevision !== undefined
              ? { expectedRevision: input.expectedRevision }
              : {}),
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),
  submitOnboardingBootstrap: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(onboardingBootstrapSubmissionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitOnboardingBootstrapAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: ctx.session.role as 'OWNER' | 'MANAGER',
          },
          submission: input,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  submitV1: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(scope.extend({ selection: intakeV1SubmissionSelection }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitIntakeV1Action({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          actorRole: ctx.session.role as 'MANAGER' | 'OWNER',
          selection: input.selection,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  amendV1: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      scope
        .extend({
          submissionId: z.string().min(1).max(191),
          expectedCurrentRevision: z.number().int().min(1),
          selection: intakeV1SubmissionSelection,
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await submitIntakeV1Action({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          actorRole: ctx.session.role as 'MANAGER' | 'OWNER',
          selection: input.selection,
          amend: {
            submissionId: input.submissionId,
            expectedCurrentRevision: input.expectedCurrentRevision,
          },
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  getV1: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      scope
        .extend({
          submissionId: z.string().min(1).max(191),
          revisionCursor: z.number().int().min(1).optional(),
          revisionLimit: z.number().int().min(1).max(20).default(20),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeV1SubmissionAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          submissionId: input.submissionId,
          revisionLimit: input.revisionLimit,
          ...(input.revisionCursor ? { revisionCursor: input.revisionCursor } : {}),
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  getV1Processing: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      scope
        .extend({
          submissionId: z.string().min(1).max(191),
          revision: z.number().int().min(1),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeV1ProcessingRead(
          {
            tenantId: ctx.session.activeTenantId,
            venueId: input.venueId,
            ownerUserId: ctx.session.userId,
            submissionId: input.submissionId,
            revision: input.revision,
            websiteResearchEnabled: env.INTAKE_V1_WEBSITE_RESEARCH_WORKERS_ENABLED,
          },
          ctx.db,
        )
      } catch (error) {
        mapActionError(error)
      }
    }),

  getLatestV1: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(scope.extend({ revisionLimit: z.number().int().min(1).max(20).default(20) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getLatestIntakeV1SubmissionAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          revisionLimit: input.revisionLimit,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  listV1Candidates: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      scope
        .extend({
          limit: z.number().int().min(1).max(50).default(25),
          cursor: z
            .object({ createdAt: z.string().datetime(), id: z.string().min(1).max(191) })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listIntakeV1CandidatesAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  listV1UploadCandidates: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(
      scope
        .extend({
          limit: z.number().int().min(1).max(50).default(25),
          cursor: z
            .object({
              createdAt: z.string().datetime(),
              id: z.string().min(1).max(191),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listIntakeV1UploadCandidatesAction({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          ownerUserId: ctx.session.userId,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  getOnboardingBootstrap: tenantProcedure
    .input(z.object({ requestId: z.string().uuid() }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getOnboardingBootstrapSubmission({
          client: ctx.db,
          tenantId: ctx.session.activeTenantId,
          requestId: input.requestId,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  createProposal: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const { venueId, requestId, draftRevision, ...proposal } = input
      try {
        return await createIntakeProposal({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: ctx.session.role as 'MANAGER' | 'OWNER',
          },
          requestId,
          proposal,
          ...(draftRevision !== undefined
            ? { draft: { ownerUserId: ctx.session.userId, expectedRevision: draftRevision } }
            : {}),
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  listProposals: tenantProcedure
    .input(scope.extend({ limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listIntakeProposals({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          limit: input.limit,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),

  getProposalReview: tenantProcedure
    .input(scope.extend({ runId: z.string().trim().min(1).max(191) }))
    .query(async ({ ctx, input }) => {
      try {
        const review = await getIntakeProposalReview({
          db: ctx.db,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          runId: input.runId,
        })
        return {
          id: review.id,
          role: review.role,
          consentVerified: review.consentVerified,
          answers: review.answers.map((answer) => ({
            questionId: answer.questionId,
            prompt: answer.prompt,
            privacy: answer.privacy,
            skipped: answer.skipped,
            redacted: answer.redacted,
            hasEvidence: answer.hasEvidence,
            publicText: answer.publicText,
          })),
        }
      } catch (error) {
        mapActionError(error)
      }
    }),
})
