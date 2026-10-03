import {
  createOperationalUpdateAction,
  expireOperationalUpdateAction,
  OperationalUpdateActionError,
  operationalUpdateActionSelect,
  scheduleOperationalUpdateAction,
  updateOperationalUpdateAction,
  type OperationalUpdateHumanActor,
} from '@pathfinder/db'
import { computeOperationalUpdateLifecycle } from '@pathfinder/contracts/operational-update-lifecycle'
import { TRPCError } from '@trpc/server'

import {
  CreateOperationalUpdateInput,
  DeactivateOperationalUpdateInput,
  OperationalUpdateLifecycleInput,
  UpdateOperationalUpdateInput,
} from '../schemas/operational-update'
import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

function actor(session: {
  userId: string | null
  role: string | null
}): OperationalUpdateHumanActor {
  return {
    type: 'HUMAN',
    id: session.userId!,
    role: session.role === 'OWNER' ? 'OWNER' : 'MANAGER',
  }
}

/** Raw fields plus the computed lifecycle: `isActive` alone never means "live now". */
function withLifecycle<
  T extends { status: string; isActive: boolean; startsAt: Date; expiresAt: Date },
>(row: T, now = new Date()) {
  const computed = computeOperationalUpdateLifecycle(row, now)
  return {
    ...row,
    lifecycle: computed.lifecycle,
    guestVisibleNow: computed.guestVisibleNow,
    isActiveButExpired: computed.isActiveButExpired,
    lifecycleLabel: computed.label,
  }
}

function mapActionError(error: unknown): never {
  if (!(error instanceof OperationalUpdateActionError)) throw error
  throw new TRPCError({
    code:
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : 'CONFLICT',
    message: error.message,
    cause: error,
  })
}

export const operationalUpdateRouter = router({
  list: tenantProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.operationalUpdate.findMany({
      where: { tenantId: ctx.session.activeTenantId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 500,
      select: operationalUpdateActionSelect,
    })
    const now = new Date()
    return rows.map((row) => withLifecycle(row, now))
  }),

  getById: tenantProcedure
    .input(OperationalUpdateLifecycleInput.pick({ id: true }))
    .query(async ({ ctx, input }) => {
      const update = await ctx.db.operationalUpdate.findFirst({
        where: { id: input.id, tenantId: ctx.session.activeTenantId },
        select: operationalUpdateActionSelect,
      })
      if (!update)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      return withLifecycle(update)
    }),

  create: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(CreateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await createOperationalUpdateAction(
          {
            tenantId: ctx.session.activeTenantId,
            actor: actor(ctx.session),
            fields: {
              venueId: input.venueId,
              placeId: input.placeId ?? null,
              updateType: input.updateType,
              severity: input.severity,
              priority: input.priority,
              title: input.title,
              body: input.body ?? null,
              redirectTo: input.redirectTo ?? null,
              startsAt: input.startsAt,
              expiresAt: input.expiresAt,
            },
            schedule: input.publish,
          },
          ctx.db,
        )
        return result.update
      } catch (error) {
        mapActionError(error)
      }
    }),

  update: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(UpdateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await updateOperationalUpdateAction(
          {
            tenantId: ctx.session.activeTenantId,
            actor: actor(ctx.session),
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
            fields: {
              venueId: input.venueId,
              placeId: input.placeId ?? null,
              updateType: input.updateType,
              severity: input.severity,
              priority: input.priority,
              title: input.title,
              body: input.body ?? null,
              redirectTo: input.redirectTo ?? null,
              startsAt: input.startsAt,
              expiresAt: input.expiresAt,
            },
            schedule: input.publish,
          },
          ctx.db,
        )
        return result.update
      } catch (error) {
        mapActionError(error)
      }
    }),

  publish: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(OperationalUpdateLifecycleInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await scheduleOperationalUpdateAction(
          {
            tenantId: ctx.session.activeTenantId,
            actor: actor(ctx.session),
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
          ctx.db,
        )
        return result.update
      } catch (error) {
        mapActionError(error)
      }
    }),

  deactivate: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(DeactivateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await expireOperationalUpdateAction(
          {
            tenantId: ctx.session.activeTenantId,
            actor: actor(ctx.session),
            id: input.id,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
          ctx.db,
        )
        return result.update
      } catch (error) {
        mapActionError(error)
      }
    }),
})
