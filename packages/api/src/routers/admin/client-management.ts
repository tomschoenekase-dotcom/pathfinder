import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  createOrganization,
  currentUser,
  validateExistingOrganizationOwner,
} from '@pathfinder/auth'
import {
  beginClientCreateIntentAction,
  clientAccountSelect,
  ClientAccountActionError,
  ClientCreateIntentError,
  completeClientCreateIntentAction,
  confirmClientCreateProviderAction,
  createClientAccountAction,
  db,
  setClientPaymentDueAction,
  startClientCreateProviderAction,
  updateClientPlanTierAction,
  updateClientStatusAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { CreateVenueRequestInput } from '../../schemas/venue'
import { adminProcedure } from '../../trpc'
import { slugify } from '../venue'
import {
  clientCreateHash,
  mapClientActionError,
  mapClientCreateIntentError,
  platformAdminActor,
} from './client-management-helpers'
import { uniqueTenantSlug } from './helpers'

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
        expectedUpdatedAt: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          setClientPaymentDueAction({
            tenantId: input.tenantId,
            nextPaymentDue: input.nextPaymentDue ? new Date(input.nextPaymentDue) : null,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: platformAdminActor(ctx.session.userId),
          }),
        )
        return { ok: true }
      } catch (error) {
        mapClientActionError(error)
      }
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
      const owner = await validateExistingOrganizationOwner({
        organizationId: input.orgId,
        userId: input.userId,
        emailAddress: input.userEmail,
      })

      try {
        await withTenantIsolationBypass(() =>
          createClientAccountAction({
            tenantId: owner.organizationId,
            name: input.name,
            slug: input.slug,
            owner: { id: owner.userId, email: owner.emailAddress },
            actor: platformAdminActor(ctx.session.userId),
          }),
        )
        return { ok: true }
      } catch (error) {
        mapClientActionError(error)
      }
    }),

  /** Creates the Clerk organization and canonical local client/venue behind a durable fence. */

  createClientAndVenue: adminProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        clientName: z.string().min(1).max(120),
        clientSlug: z.string().min(1).max(80).optional(),
        venue: CreateVenueRequestInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = platformAdminActor(ctx.session.userId)
      const requestHash = clientCreateHash({
        clientName: input.clientName,
        ...(input.clientSlug !== undefined ? { clientSlug: input.clientSlug } : {}),
        venue: input.venue,
      })
      let intent
      try {
        intent = await beginClientCreateIntentAction({
          requestId: input.requestId,
          requestHash,
          actor,
        })
      } catch (error) {
        if (error instanceof ClientCreateIntentError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message })
        }
        throw error
      }
      if (intent.state === 'COMPLETED') {
        const completed = await withTenantIsolationBypass(() =>
          Promise.all([
            db.tenant.findUnique({ where: { id: intent.tenantId }, select: clientAccountSelect }),
            db.venue.findFirst({
              where: { id: intent.venueId, tenantId: intent.tenantId },
              select: { id: true, name: true, slug: true },
            }),
          ]),
        )
        if (!completed[0] || !completed[1]) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Completed client setup is unavailable',
          })
        }
        return { tenant: completed[0], venue: completed[1] }
      }
      if (intent.state === 'RECONCILIATION_REQUIRED') {
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Provider outcome is unconfirmed. Reconcile this request to the verified organization before continuing.',
        })
      }
      const tenantSlug = await uniqueTenantSlug(slugify(input.clientSlug ?? input.clientName))
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
      if (intent.state === 'READY') {
        const started = await startClientCreateProviderAction({
          requestId: input.requestId,
          requestHash,
          localSlug: tenantSlug,
          actor,
        })
        if (started.state !== 'CALL_PROVIDER') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Provider creation is already in progress or requires reconciliation.',
          })
        }
      }
      let organization: Awaited<ReturnType<typeof createOrganization>>
      if (intent.state === 'PROVIDER_CONFIRMED') {
        const verified = await validateExistingOrganizationOwner({
          organizationId: intent.providerOrganizationId,
          userId: ctx.session.userId,
          emailAddress: adminEmail,
        })
        organization = {
          id: verified.organizationId,
          name: verified.organizationName,
          slug: intent.localSlug,
        }
      } else {
        try {
          organization = await createOrganization({
            name: input.clientName,
            slug: tenantSlug,
            createdByUserId: ctx.session.userId,
          })
        } catch {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message:
              'Identity-provider outcome is unconfirmed. Reconcile this request before retrying.',
          })
        }
        try {
          await confirmClientCreateProviderAction({
            requestId: input.requestId,
            requestHash,
            providerOrganizationId: organization.id,
            actor,
          })
        } catch (error) {
          mapClientCreateIntentError(error)
        }
      }

      try {
        const result = await withTenantIsolationBypass(() =>
          createClientAccountAction({
            tenantId: organization.id,
            name: input.clientName,
            slug: organization.slug,
            owner: { id: ctx.session.userId, email: adminEmail },
            actor,
            initialVenue: {
              name: input.venue.name,
              slug: slugify(input.venue.slug ?? input.venue.name),
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
          }),
        )
        if (!result.venue) throw new Error('Initial venue result was missing')
        await completeClientCreateIntentAction({
          requestId: input.requestId,
          requestHash,
          providerOrganizationId: organization.id,
          tenantId: result.tenant.id,
          venueId: result.venue.id,
          actor,
        })
        return { tenant: result.tenant, venue: result.venue }
      } catch (error) {
        if (error instanceof ClientAccountActionError && error.code === 'CONFLICT') {
          mapClientActionError(error)
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            'The provider organization exists, but local client setup did not complete. Reconcile it before retrying.',
        })
      }
    }),

  reconcileClientAndVenue: adminProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        organizationId: z.string().min(1),
        clientName: z.string().min(1).max(120),
        clientSlug: z.string().min(1).max(80).optional(),
        venue: CreateVenueRequestInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = platformAdminActor(ctx.session.userId)
      const requestHash = clientCreateHash({
        clientName: input.clientName,
        ...(input.clientSlug !== undefined ? { clientSlug: input.clientSlug } : {}),
        venue: input.venue,
      })
      const adminUser = await currentUser()
      const adminEmail =
        adminUser?.emailAddresses.find((address) => address.id === adminUser.primaryEmailAddressId)
          ?.emailAddress ?? adminUser?.emailAddresses[0]?.emailAddress
      if (!adminEmail)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Admin email unavailable' })
      const verified = await validateExistingOrganizationOwner({
        organizationId: input.organizationId,
        userId: ctx.session.userId,
        emailAddress: adminEmail,
      })
      try {
        await confirmClientCreateProviderAction({
          requestId: input.requestId,
          requestHash,
          providerOrganizationId: verified.organizationId,
          actor,
        })
      } catch (error) {
        mapClientCreateIntentError(error)
      }
      return { confirmed: true as const }
    }),

  updateClientStatus: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']),
        expectedUpdatedAt: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          updateClientStatusAction({
            tenantId: input.tenantId,
            status: input.status,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: platformAdminActor(ctx.session.userId),
          }),
        )
        return { ok: true }
      } catch (error) {
        mapClientActionError(error)
      }
    }),

  updateClientPlanTier: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        planTier: z.enum(['free', 'pro', 'enterprise']),
        expectedUpdatedAt: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await withTenantIsolationBypass(() =>
          updateClientPlanTierAction({
            tenantId: input.tenantId,
            planTier: input.planTier,
            expectedUpdatedAt: new Date(input.expectedUpdatedAt),
            actor: platformAdminActor(ctx.session.userId),
          }),
        )
        return { ok: true }
      } catch (error) {
        mapClientActionError(error)
      }
    }),
})
