import { requireTenantRole, type TenantRole } from '@pathfinder/auth'

import { t } from '../core'
import type { SessionContext } from '@pathfinder/auth'
import type { TRPCContext } from '../context'

export function requireRole(minRole: TenantRole) {
  return t.middleware(({ ctx, next }) => {
    requireTenantRole(ctx.session as SessionContext, minRole)

    return next({
      ctx: {
        ...ctx,
        session: ctx.session as SessionContext & { activeTenantId: string; role: TenantRole },
      } satisfies TRPCContext & {
        session: SessionContext & { activeTenantId: string; role: TenantRole }
      },
    })
  })
}
