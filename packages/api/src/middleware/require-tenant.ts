import { TRPCError } from '@trpc/server'

import { t } from '../core'
import type { SessionContext } from '@pathfinder/auth'
import type { TRPCContext } from '../context'

export const requireTenant = t.middleware(({ ctx, next }) => {
  if (ctx.session.activeTenantId === null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Tenant context required',
    })
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session as SessionContext & { activeTenantId: string },
    } satisfies TRPCContext & {
      session: SessionContext & { activeTenantId: string }
    },
  })
})
