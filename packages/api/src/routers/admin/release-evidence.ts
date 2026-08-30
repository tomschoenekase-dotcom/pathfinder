import { ReleaseEvidenceRecordPayload } from '@pathfinder/contracts/release-evidence'
import {
  PlatformReleaseEvidenceError,
  readPlatformReleaseEvidence,
  recordPlatformReleaseEvidenceAction,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function mapped(error: unknown): never {
  if (error instanceof PlatformReleaseEvidenceError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'INACTIVE_CREDENTIAL'
            ? 'UNAUTHORIZED'
            : 'CONFLICT',
      message: error.message,
    })
  }
  throw error
}

export const adminReleaseEvidenceRouter = router({
  releaseEvidence: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(25).default(5) })
        .strict()
        .optional(),
    )
    .query(({ input }) => readPlatformReleaseEvidence(input?.limit ?? 5)),

  recordReleaseEvidence: adminProcedure
    .input(ReleaseEvidenceRecordPayload)
    .mutation(async ({ ctx, input }) => {
      try {
        return await recordPlatformReleaseEvidenceAction({
          ...input,
          actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
        })
      } catch (error) {
        return mapped(error)
      }
    }),
})
