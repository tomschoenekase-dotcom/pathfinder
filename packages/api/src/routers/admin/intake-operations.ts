import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeActionError,
  OnboardingBootstrapError,
  createIntakeProposal,
  getIntakeProposalReview,
  interviewProposalInput,
  linkIntakePackageDraft,
  listOnboardingBootstrapDetails,
  listIntakeProposals,
  websiteProposalInput,
} from '@pathfinder/db'

import { router } from '../../core'
import { intakeReviewedDraftFinalizer } from '../../lib/admin-reviewed-draft-finalizers'
import { runAdminReviewedDraftOrchestration } from '../../lib/admin-reviewed-draft-orchestration'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { adminProcedure } from '../../trpc'

const adminScope = { tenantId: z.string().min(1), venueId: z.string().min(1) }
const createInput = z.discriminatedUnion('kind', [
  websiteProposalInput.extend({ ...adminScope, requestId: z.string().uuid() }).strict(),
  interviewProposalInput.extend({ ...adminScope, requestId: z.string().uuid() }).strict(),
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

export const adminIntakeOperationsRouter = router({
  createAndLinkIntakeReviewedVenuePackageDraft: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          intakeRunId: z.string().min(1),
          draftKey: z.string().uuid(),
          payload: VenuePackagePayload,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      runAdminReviewedDraftOrchestration({
        ctx,
        tenantId: input.tenantId,
        draft: { venueId: input.venueId, draftKey: input.draftKey, payload: input.payload },
        finalizer: intakeReviewedDraftFinalizer({
          actorId: ctx.session.userId,
          intakeRunId: input.intakeRunId,
        }),
      }),
    ),

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

  linkIntakePackageDraft: adminProcedure
    .input(
      z
        .object({
          ...adminScope,
          runId: z.string().min(1),
          packageDraftId: z.string().min(1),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await linkIntakePackageDraft({
          db: ctx.db,
          ...input,
          actorId: ctx.session.userId,
        })
      } catch (error) {
        mapActionError(error)
      }
    }),
})
