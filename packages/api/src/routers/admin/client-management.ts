import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  createOrganization,
  currentUser,
  validateExistingOrganizationOwner,
} from '@pathfinder/auth'
import {
  db,
  setContentVersionContext,
  withTenantIsolationBypass,
  writeAuditLog,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { CreateVenueRequestInput } from '../../schemas/venue'
import { adminProcedure } from '../../trpc'
import { slugify } from '../venue'
import { isUniqueConstraintError, uniqueTenantSlug } from './helpers'

export const adminClientManagementRouter = router({
  listClients: adminProcedure.query(async () => {
    return withTenantIsolationBypass(() =>
      db.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        // Compatibility-only endpoint. New interfaces use searchClients;
        // keep legacy callers bounded until the procedure can be removed.
        take: 100,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          createdAt: true,
          memberships: {
            where: { status: 'ACTIVE' },
            select: {
              id: true,
              role: true,
              user: { select: { email: true, fullName: true } },
            },
          },
        },
      }),
    )
  }),

  /**
   * Platform-admin-only mutation to set or clear a tenant's next payment due
   * date. Visible read-only to operators; editable for admins viewing a tenant.
   */

  setTenantPaymentDue: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        nextPaymentDue: z.string().datetime().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await withTenantIsolationBypass(async () => {
        await db.tenant.update({
          where: { id: input.tenantId },
          data: {
            nextPaymentDue: input.nextPaymentDue ? new Date(input.nextPaymentDue) : null,
          },
        })
      })

      return { ok: true }
    }),

  createClient: adminProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1),
        userId: z.string().min(1),
        userEmail: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await withTenantIsolationBypass(() =>
        db.tenant.findUnique({ where: { id: input.orgId } }),
      )
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A client with this org ID already exists',
        })
      }

      const owner = await validateExistingOrganizationOwner({
        organizationId: input.orgId,
        userId: input.userId,
        emailAddress: input.userEmail,
      })

      await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          try {
            await tx.tenant.create({
              data: { id: owner.organizationId, name: input.name, slug: input.slug },
            })
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'A client with this organization ID or slug already exists',
              })
            }
            throw error
          }

          await tx.user.upsert({
            where: { id: owner.userId },
            create: { id: owner.userId, email: owner.emailAddress },
            update: { email: owner.emailAddress },
          })

          await tx.tenantMembership.upsert({
            where: {
              tenantId: owner.organizationId,
              tenantId_userId: { tenantId: owner.organizationId, userId: owner.userId },
            },
            create: {
              tenantId: owner.organizationId,
              userId: owner.userId,
              role: 'OWNER',
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
            update: { role: 'OWNER', status: 'ACTIVE' },
          })

          await writeAuditLogStrict(
            {
              tenantId: owner.organizationId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'admin.client.created',
              targetType: 'Tenant',
              targetId: owner.organizationId,
              afterState: {
                id: owner.organizationId,
                name: input.name,
                slug: input.slug,
                ownerUserId: owner.userId,
              },
            },
            tx,
          )
        }),
      )

      return { ok: true }
    }),

  /**
   * Creates a brand-new client end-to-end: a real Clerk Organization, its
   * Tenant row, the calling admin as its OWNER (so they can immediately
   * manage it and, later, switch into the org via the picker to invite the
   * real client through the existing Settings invite flow), and a first
   * Venue. Lets an admin onboard a client who won't self-serve a Clerk
   * account, instead of the old workaround of hand-creating a throwaway
   * account per venue.
   */

  createClientAndVenue: adminProcedure
    .input(
      z.object({
        clientName: z.string().min(1).max(120),
        clientSlug: z.string().min(1).max(80).optional(),
        venue: CreateVenueRequestInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tenantSlug = await uniqueTenantSlug(slugify(input.clientSlug ?? input.clientName))

      const organization = await createOrganization({
        name: input.clientName,
        slug: tenantSlug,
        createdByUserId: ctx.session.userId,
      })

      const adminUser = await currentUser()
      const adminEmail =
        adminUser?.emailAddresses.find((address) => address.id === adminUser.primaryEmailAddressId)
          ?.emailAddress ?? adminUser?.emailAddresses[0]?.emailAddress

      if (!adminEmail) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not resolve the admin email address',
        })
      }

      const { tenant, venue } = await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          await setContentVersionContext(tx, { actorId: ctx.session.userId })
          const tenant = await tx.tenant.create({
            data: { id: organization.id, name: input.clientName, slug: organization.slug },
          })

          await tx.user.upsert({
            where: { id: ctx.session.userId },
            create: { id: ctx.session.userId, email: adminEmail },
            update: { email: adminEmail },
          })

          await tx.tenantMembership.upsert({
            where: {
              tenantId: organization.id,
              tenantId_userId: { tenantId: organization.id, userId: ctx.session.userId },
            },
            create: {
              tenantId: organization.id,
              userId: ctx.session.userId,
              role: 'OWNER',
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
            update: { role: 'OWNER', status: 'ACTIVE' },
          })

          const venueSlug = slugify(input.venue.slug ?? input.venue.name)

          const venue = await tx.venue.create({
            data: {
              tenantId: organization.id,
              name: input.venue.name,
              slug: venueSlug,
              guideMode: input.venue.guideMode ?? 'location_aware',
              ...(input.venue.description !== undefined
                ? { description: input.venue.description }
                : {}),
              ...(input.venue.guideNotes !== undefined
                ? { guideNotes: input.venue.guideNotes }
                : {}),
              ...(input.venue.category !== undefined ? { category: input.venue.category } : {}),
              ...(input.venue.defaultCenterLat !== undefined
                ? { defaultCenterLat: input.venue.defaultCenterLat }
                : {}),
              ...(input.venue.defaultCenterLng !== undefined
                ? { defaultCenterLng: input.venue.defaultCenterLng }
                : {}),
            },
            select: { id: true, name: true, slug: true },
          })

          return { tenant, venue }
        }),
      )

      await writeAuditLog({
        tenantId: organization.id,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.created',
        targetType: 'Tenant',
        targetId: organization.id,
        afterState: {
          id: organization.id,
          name: input.clientName,
          slug: tenantSlug,
          venueId: venue.id,
        },
      })

      return { tenant, venue }
    }),

  updateClientStatus: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await withTenantIsolationBypass(async () => {
        const existing = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true, status: true },
        })

        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const tenant = await db.tenant.update({
          where: { id: input.tenantId },
          data: { status: input.status },
          select: { id: true, status: true },
        })

        return { existing, tenant }
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.status_updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: updated.existing,
        afterState: updated.tenant,
      })

      return { ok: true }
    }),

  updateClientPlanTier: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        planTier: z.enum(['free', 'pro', 'enterprise']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await withTenantIsolationBypass(async () => {
        const existing = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true, planTier: true },
        })

        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const tenant = await db.tenant.update({
          where: { id: input.tenantId },
          data: { planTier: input.planTier },
          select: { id: true, planTier: true },
        })

        return { existing, tenant }
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.plan_updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: updated.existing,
        afterState: updated.tenant,
      })

      return { ok: true }
    }),
})
