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
import { createVenuePackageDraftService } from '../venue-package'
import {
  buildIntakeVenuePackageCandidate,
  isExactIntakeCandidateHandoff,
  intakeCandidateDraftKey,
  IntakeVenuePackageCandidateError,
} from '../../lib/intake-venue-package-candidate'
import { adminProcedure } from '../../trpc'

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
  getIntakeBuilderLifecycle: adminProcedure
    .input(z.object({ ...adminScope, runId: z.string().trim().min(1).max(191) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getIntakeBuilderLifecycle({ db: ctx.db, ...input })
      } catch (error) {
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
