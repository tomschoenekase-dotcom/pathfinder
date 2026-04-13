import { TRPCError } from '@trpc/server'

import { t } from '../core'
import type { TRPCContext } from '../context'
import type { SessionContext } from '@pathfinder/auth'

export const requireAuth = t.middleware(({ ctx, next }) => {
  if (ctx.session.userId === null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    })
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session as SessionContext,
    } satisfies TRPCContext & { session: SessionContext },
  })
})
