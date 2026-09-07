import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { IntakeV1PackageHandoffError } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  buildIntakeV1PackageCandidate,
  IntakeV1PackageCandidateError,
} from '../../lib/intake-v1-package-candidate'
import {
  createIntakeV1PackageDraftForAdmin,
  IntakeV1PackageDraftCommand,
} from '../../lib/intake-v1-package-draft'

const previewInput = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    submissionId: z.string().min(1).max(191),
    revision: z.number().int().min(1),
    selectedMemberIds: z.array(z.string().min(1).max(191)).min(1).max(50),
  })
  .strict()

function rethrow(error: unknown): never {
  if (
    error instanceof IntakeV1PackageCandidateError ||
    error instanceof IntakeV1PackageHandoffError
  )
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  throw error
}

export const adminIntakeV1PackagesRouter = router({
  previewIntakeV1Package: adminProcedure.input(previewInput).query(async ({ ctx, input }) => {
    try {
      return await buildIntakeV1PackageCandidate({ db: ctx.db, ...input })
    } catch (error) {
      rethrow(error)
    }
  }),
  createIntakeV1PackageDraft: adminProcedure
    .input(IntakeV1PackageDraftCommand)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createIntakeV1PackageDraftForAdmin({
          db: ctx.db,
          actorId: ctx.session.userId,
          command: input,
        })
      } catch (error) {
        rethrow(error)
      }
    }),
})
