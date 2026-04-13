import { TRPCError } from '@trpc/server'

import type { SessionContext, TenantRole } from './session'

const ROLE_HIERARCHY: Record<TenantRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
}

export function requireTenantRole(
  ctx: SessionContext,
  minRole: TenantRole,
): asserts ctx is SessionContext & { activeTenantId: string; role: TenantRole } {
  if (ctx.activeTenantId === null || ctx.role === null || ROLE_HIERARCHY[ctx.role] < ROLE_HIERARCHY[minRole]) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Insufficient role',
    })
  }
}

export function requirePlatformAdmin(
  ctx: SessionContext,
): asserts ctx is SessionContext & { isPlatformAdmin: true } {
  if (!ctx.isPlatformAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Insufficient role',
    })
  }
}

export const permissionInternals = {
  ROLE_HIERARCHY,
}
