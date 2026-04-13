import { requirePlatformAdmin } from '@pathfinder/auth'

import { t } from '../core'
import type { SessionContext } from '@pathfinder/auth'
import type { TRPCContext } from '../context'

export const requirePlatformAdminMiddleware = t.middleware(({ ctx, next }) => {
  requirePlatformAdmin(ctx.session as SessionContext)

  return next({
    ctx: {
      ...ctx,
      session: ctx.session as SessionContext & { isPlatformAdmin: true },
    } satisfies TRPCContext & {
      session: SessionContext & { isPlatformAdmin: true }
    },
  })
})
