import { TRPCError } from '@trpc/server'

import {
  authorizeGuestConversationDispositionAction,
  GuestConversationDispositionAuthorizationInput,
  GuestConversationDispositionAuthorityError,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminGuestConversationDispositionRouter = router({
  authorizeGuestConversationDisposition: adminProcedure
    .input(GuestConversationDispositionAuthorizationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await authorizeGuestConversationDispositionAction(
          input,
          {
            userId: ctx.session.userId,
            isPlatformAdmin: ctx.session.isPlatformAdmin,
          },
          ctx.db,
        )
      } catch (error) {
        if (error instanceof GuestConversationDispositionAuthorityError) {
          throw new TRPCError({
            code: error.code === 'SCOPE_NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.code,
          })
        }
        throw error
      }
    }),
})
