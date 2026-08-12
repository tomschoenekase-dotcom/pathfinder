import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeActionError,
  OnboardingBootstrapError,
  createIntakeProposal,
  getIntakeProposalReview,
  getOnboardingBootstrapSubmission,
  interviewProposalInput,
  listIntakeProposals,
  onboardingBootstrapSubmissionInput,
  submitOnboardingBootstrapAction,
  websiteProposalInput,
} from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

const scope = z.object({ venueId: z.string().min(1) }).strict()
const createInput = z.discriminatedUnion('kind', [
  websiteProposalInput
    .extend({ venueId: z.string().min(1), requestId: z.string().uuid() })
    .strict(),
  interviewProposalInput
    .extend({ venueId: z.string().min(1), requestId: z.string().uuid() })
    .strict(),
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

export const intakeRouter = router({
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
      const { venueId, requestId, ...proposal } = input
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
