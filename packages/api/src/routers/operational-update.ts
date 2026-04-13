import { TRPCError } from '@trpc/server'
import { requireTenantRole, type SessionContext } from '@pathfinder/auth'
import { writeAuditLog } from '@pathfinder/db'

import {
  CreateOperationalUpdateInput,
  DeactivateOperationalUpdateInput,
} from '../schemas/operational-update'
import { router } from '../core'
import type { TRPCContext } from '../context'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

type DbClient = TRPCContext['db']

const operationalUpdateSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  placeId: true,
  severity: true,
  title: true,
  body: true,
  redirectTo: true,
  expiresAt: true,
  isActive: true,
  createdBy: true,
  createdAt: true,
  venue: {
    select: {
      id: true,
      name: true,
    },
  },
  place: {
    select: {
      id: true,
      name: true,
    },
  },
} as const

function toAuditState(update: {
  id: string
  venueId: string
  placeId: string | null
  severity: string
  title: string
  body: string | null
  redirectTo: string | null
  expiresAt: Date
  isActive: boolean
  createdBy: string
  createdAt: Date
}) {
  return {
    id: update.id,
    venueId: update.venueId,
    placeId: update.placeId,
    severity: update.severity,
    title: update.title,
    body: update.body,
    redirectTo: update.redirectTo,
    expiresAt: update.expiresAt.toISOString(),
    isActive: update.isActive,
    createdBy: update.createdBy,
    createdAt: update.createdAt.toISOString(),
  }
}

async function assertVenueBelongsToTenant(
  db: DbClient,
  venueId: string,
  tenantId: string,
) {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })

  if (!venue) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
  }
}

async function assertPlaceBelongsToVenue(
  db: DbClient,
  placeId: string,
  venueId: string,
  tenantId: string,
) {
  const place = await db.place.findFirst({
    where: { id: placeId, venueId, tenantId },
    select: { id: true },
  })

  if (!place) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
  }
}

function requireSeverityRole(session: SessionContext, severity: 'INFO' | 'WARNING' | 'CLOSURE' | 'REDIRECT') {
  if (severity === 'CLOSURE' || severity === 'REDIRECT') {
    requireTenantRole(session, 'MANAGER')
    return
  }

  requireTenantRole(session, 'STAFF')
}

export const operationalUpdateRouter = router({
  list: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.operationalUpdate.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        isActive: true,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      select: operationalUpdateSelect,
    })
  }),

  create: tenantProcedure
    .input(CreateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId
      requireSeverityRole(ctx.session as SessionContext, input.severity)

      await assertVenueBelongsToTenant(ctx.db, input.venueId, tenantId)

      if (input.placeId) {
        await assertPlaceBelongsToVenue(ctx.db, input.placeId, input.venueId, tenantId)
      }

      const created = await ctx.db.operationalUpdate.create({
        data: {
          tenantId,
          venueId: input.venueId,
          severity: input.severity,
          title: input.title,
          expiresAt: input.expiresAt,
          createdBy: ctx.session.userId,
          ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.redirectTo !== undefined ? { redirectTo: input.redirectTo } : {}),
        },
        select: operationalUpdateSelect,
      })

      await writeAuditLog({
        tenantId,
        actorId: ctx.session.userId,
        actorRole: ctx.session.role ?? 'STAFF',
        action: 'operational-update.created',
        targetType: 'OperationalUpdate',
        targetId: created.id,
        afterState: toAuditState(created),
      })

      return created
    }),

  deactivate: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(DeactivateOperationalUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.session.activeTenantId

      const existing = await ctx.db.operationalUpdate.findFirst({
        where: {
          id: input.id,
          tenantId,
        },
        select: operationalUpdateSelect,
      })

      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Operational update not found' })
      }

      await ctx.db.operationalUpdate.updateMany({
        where: {
          id: input.id,
          tenantId,
        },
        data: {
          isActive: false,
        },
      })

      const deactivated = {
        ...existing,
        isActive: false,
      }

      await writeAuditLog({
        tenantId,
        actorId: ctx.session.userId,
        actorRole: ctx.session.role ?? 'MANAGER',
        action: 'operational-update.deactivated',
        targetType: 'OperationalUpdate',
        targetId: existing.id,
        beforeState: toAuditState(existing),
        afterState: toAuditState(deactivated),
      })

      return deactivated
    }),
})
