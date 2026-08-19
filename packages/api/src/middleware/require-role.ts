import { requireTenantRole, type TenantRole } from '@pathfinder/auth'

import { t } from '../core'
import type { SessionContext } from '@pathfinder/auth'
import type { TRPCContext } from '../context'

export function requireRole(minRole: TenantRole) {
  return t.middleware(({ ctx, next }) => {
    const session = ctx.session as SessionContext

    // Platform admins select an explicit tenant through the signed, HTTP-only
    // impersonation cookie. They are intentionally not added to the client's
    // Clerk organization, so Clerk supplies no organization role for that
    // session. Treat the already tenant-fenced admin as an OWNER for tenant
    // procedure authorization and audit attribution. An admin without a
    // selected tenant still fails closed here.
    const effectiveSession =
      session.isPlatformAdmin && session.activeTenantId !== null
        ? { ...session, role: 'OWNER' as const }
        : session

    requireTenantRole(effectiveSession, minRole)

    return next({
      ctx: {
        ...ctx,
        session: effectiveSession,
      } satisfies TRPCContext & {
        session: SessionContext & { activeTenantId: string; role: TenantRole }
      },
    })
  })
}
