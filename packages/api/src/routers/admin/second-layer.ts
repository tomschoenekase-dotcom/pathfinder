import { randomUUID } from 'node:crypto'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const targetInput = z
  .object({
    tenantId: z.string().min(1).max(128),
    venueId: z.string().min(1).max(128),
  })
  .strict()

export const adminSecondLayerRouter = router({
  getSecondLayerEntitlement: adminProcedure.input(targetInput).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      const venue = await db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: {
          id: true,
          secondLayerEnabled: true,
          secondLayerLabel: true,
          updatedAt: true,
        },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      return venue
    }),
  ),

  setSecondLayerEntitlement: adminProcedure
    .input(
      targetInput
        .extend({
          enabled: z.boolean(),
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          const before = await tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: {
              id: true,
              secondLayerEnabled: true,
              secondLayerLabel: true,
              secondLayerAccessKey: true,
              updatedAt: true,
            },
          })
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
          if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Second-layer entitlement changed; refresh and try again.',
            })
          }
          if (before.secondLayerEnabled === input.enabled) return { ...before, replayed: true }

          const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
          const changed = await tx.venue.updateMany({
            where: {
              id: input.venueId,
              tenantId: input.tenantId,
              updatedAt: before.updatedAt,
            },
            data: {
              secondLayerEnabled: input.enabled,
              secondLayerAccessKey: input.enabled ? randomUUID() : null,
              updatedAt,
            },
          })
          if (changed.count !== 1) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Second-layer entitlement changed.' })
          }
          await tx.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.enabled ? 'admin.second-layer.enabled' : 'admin.second-layer.disabled',
              targetType: 'Venue',
              targetId: input.venueId,
              beforeState: { enabled: before.secondLayerEnabled },
              afterState: { enabled: input.enabled },
            },
          })
          return {
            id: before.id,
            secondLayerEnabled: input.enabled,
            secondLayerLabel: before.secondLayerLabel,
            updatedAt,
            replayed: false,
          }
        }),
      ),
    ),
})
