import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'
import {
  inviteOrganizationMember,
  listPendingOrganizationInvitations,
  requireTenantRole,
} from '@pathfinder/auth'
import type { SessionContext } from '@pathfinder/auth'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

// Team management is OWNER-only, same as other tenant-membership-affecting
// actions — except platform admins, who manage clients while impersonating
// (a cookie override) rather than as a real member with a real org role.
function assertCanManageTeam(session: SessionContext & { activeTenantId: string }) {
  if (session.isPlatformAdmin) return
  requireTenantRole(session, 'OWNER')
}

export const tenantRouter = router({
  /**
   * Returns the current tenant's settings and full non-removed member list.
   * Used by the dashboard settings page.
   */
  getSettings: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId

    const [tenant, members] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          nextPaymentDue: true,
          engagementMode: true,
        },
      }),
      db.tenantMembership.findMany({
        where: { tenantId, status: { not: 'REMOVED' } },
        select: {
          id: true,
          role: true,
          status: true,
          joinedAt: true,
          createdAt: true,
          user: {
            select: { id: true, email: true, fullName: true, avatarUrl: true },
          },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
    ])

    if (!tenant) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' })
    }

    return { tenant, members }
  }),

  /**
   * Invites someone into the current tenant's Clerk org by email, via the
   * Backend API (not the client-side Clerk SDK) so it targets whichever
   * tenant is actually active server-side — including a platform admin's
   * impersonated tenant, which the browser's real Clerk org state can't see.
   */
  inviteMember: tenantProcedure
    .input(
      z
        .object({
          emailAddress: z.string().email(),
          role: z.enum(['org:admin', 'org:member']),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      assertCanManageTeam(ctx.session)

      return inviteOrganizationMember({
        organizationId: ctx.session.activeTenantId,
        emailAddress: input.emailAddress,
        role: input.role,
        inviterUserId: ctx.session.userId,
      })
    }),

  listPendingInvitations: tenantProcedure.query(async ({ ctx }) => {
    return listPendingOrganizationInvitations(ctx.session.activeTenantId)
  }),

  setEngagementMode: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ mode: z.enum(['STOIC', 'BALANCED', 'CURIOUS']) }).strict())
    .mutation(async ({ ctx, input }) => {
      await db.tenant.update({
        where: { id: ctx.session.activeTenantId },
        data: { engagementMode: input.mode },
      })

      return { ok: true }
    }),
})
