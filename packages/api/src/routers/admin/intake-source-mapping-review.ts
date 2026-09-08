import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { IntakeSourceMappingReviewError } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  WebsiteSourceMappingReviewInput,
  OptionalNotesSourceMappingReviewInput,
  reviewIntakeSourceMappingForV1,
} from '../../lib/intake-source-mapping-review'

// Reviewer identity comes only from the authenticated administrator. The service
// revalidates the complete command, including the notes range refinement.
const reviewInput = z.union([
  WebsiteSourceMappingReviewInput.omit({ reviewedBy: true }),
  OptionalNotesSourceMappingReviewInput.innerType().omit({ reviewedBy: true }),
])

export const adminIntakeSourceMappingReviewRouter = router({
  reviewIntakeSourceMapping: adminProcedure.input(reviewInput).mutation(async ({ ctx, input }) => {
    try {
      return await reviewIntakeSourceMappingForV1({
        db: ctx.db,
        command: { ...input, reviewedBy: ctx.session.userId },
      })
    } catch (error) {
      if (error instanceof IntakeSourceMappingReviewError)
        throw new TRPCError({
          code:
            error.code === 'INVALID_INPUT'
              ? 'BAD_REQUEST'
              : error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : 'CONFLICT',
          message: error.message,
        })
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          'The source mapping could not be saved. Refresh its evidence and review the selection.',
      })
    }
  }),
})
