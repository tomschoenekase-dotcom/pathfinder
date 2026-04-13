import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { adminProcedure } from '../../trpc'
import { router } from '../../core'

export const adminRouter = router({
  ping: adminProcedure.query(() => ({
    ok: true,
    scope: 'admin',
  })),

  listClients: adminProcedure.query(async () => {
    return withTenantIsolationBypass(() =>
      db.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            include: { user: true },
          },
        },
      })
    )
  }),

  createClient: adminProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1),
        userId: z.string().min(1),
        userEmail: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const existing = await withTenantIsolationBypass(() =>
        db.tenant.findUnique({ where: { id: input.orgId } })
      )
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A client with this org ID already exists' })
      }

      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: input.orgId, name: input.name, slug: input.slug },
        })

        await db.user.upsert({
          where: { id: input.userId },
          create: { id: input.userId, email: input.userEmail },
          update: { email: input.userEmail },
        })

        await db.tenantMembership.upsert({
          where: { tenantId_userId: { tenantId: input.orgId, userId: input.userId } },
          create: {
            tenantId: input.orgId,
            userId: input.userId,
            role: 'OWNER',
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
          update: { role: 'OWNER', status: 'ACTIVE' },
        })
      })

      return { ok: true }
    }),

  updateClientStatus: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']),
      })
    )
    .mutation(async ({ input }) => {
      await withTenantIsolationBypass(() =>
        db.tenant.update({
          where: { id: input.tenantId },
          data: { status: input.status },
        })
      )
      return { ok: true }
    }),
})
