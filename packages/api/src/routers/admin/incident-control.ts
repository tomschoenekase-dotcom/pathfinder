import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  GlobalAiControlActionError,
  readGlobalAiControl,
  setGlobalAiControlAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const updateInput = z
  .object({
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    expectedUpdatedAt: z.coerce.date().nullable(),
  })
  .strict()

function conflict(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'Global AI control changed; refresh and try again.',
  })
}

function mapActionError(error: unknown): never {
  if (error instanceof GlobalAiControlActionError) {
    if (error.code === 'CONFLICT') conflict()
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error })
  }
  throw error
}

export const adminIncidentControlRouter = router({
  getGlobalAiControl: adminProcedure.query(() => readGlobalAiControl(db)),

  setGlobalAiControl: adminProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    try {
      return await setGlobalAiControlAction(
        {
          ...input,
          actor: {
            type: 'HUMAN',
            id: ctx.session.userId,
            role: 'PLATFORM_ADMIN',
          },
        },
        db,
      )
    } catch (error) {
      mapActionError(error)
    }
  }),
})
