import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  IntakeActionError,
  OnboardingBootstrapError,
  createIntakeProposal,
  interviewProposalInput,
  linkIntakePackageDraft,
  listOnboardingBootstrapDetails,
  listIntakeProposals,
  websiteProposalInput,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const adminScope = { tenantId: z.string().min(1), venueId: z.string().min(1) }
const createInput = z.discriminatedUnion('kind', [
  websiteProposalInput.extend(adminScope).strict(),
  interviewProposalInput.extend(adminScope).strict(),
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

  createIntakeProposal: adminProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const { tenantId, venueId, ...proposal } = input
    try {
      return await createIntakeProposal({
        db: ctx.db,
        tenantId,
        venueId,
        actorId: ctx.session.userId,
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
