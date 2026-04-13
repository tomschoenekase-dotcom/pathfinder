import { router, t } from './core'
import { requireAuth } from './middleware/require-auth'
import { requirePlatformAdminMiddleware } from './middleware/require-platform-admin'
import { requireTenant } from './middleware/require-tenant'

export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(requireAuth)
export const tenantProcedure = t.procedure.use(requireAuth).use(requireTenant)
export const adminProcedure = t.procedure.use(requireAuth).use(requirePlatformAdminMiddleware)
